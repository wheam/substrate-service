// keeper 的确定性执行器：LLM 只出决定，落盘永远走这里（直改文件或调实例 vendored 脚本）。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseZones } from './acl.js';
import { newContentId, readContentId } from './content-id.js';
import { parseEntryBody, scanSegments, INBOX_PREVIEW_CHARS } from './inbox.js';
import { normTier, readTier, hasExplicitTier, setTierLine, TIER_RANK, DECISION_TIERS } from './tier.js';
import { applyCoreCalibration, extractCoreDraft } from './core-calibration.js';

const DISPOSITIONS = new Set(['canonical', 'reference', 'local-only', 'forbidden']);
// schema_apply（M4.4 D2b）：落地一个 zone 提案。内容只认提案件正文的 json 块，decision 只能「指向」件（白名单原则）。
// merge_pages（M4.4 D3）：夜班去重/薄页合并的确定性落点——现有 merge_into 并入的是 entry.body（收件正文），
// 对夜班提案件那是「提案文案」，执行它语义全错；真语义 = 源页正文并入目标页 + 删源页清反链，须一个原子动作表达。
const ACTIONS = new Set(['new_page', 'merge_into', 'upsert_row', 'todo_add', 'remove_page', 'todo_done', 'schema_apply', 'merge_pages']);
// set_tier（M4.6 D1）刻意【不】进 ACTIONS：它是可逆降级/晋升，绝不能从 keeper 的 LLM decision 触达
// （否则注入内容可诱导 keeper 把任意页降级=软删除，绕过 remove_page 的裁定保护）。它只有两个确定性入口——
// ① 夜班进程内扫描后直执行降级；② 高信任 page_set_tier 工具 re-promote——均直调 setPageTier、不经 validateDecision。
export const SET_TIER_TARGETS = new Set(['canonical', 'candidate']);
// 缺陷3：只有落成页文件的 action（new_page/merge_into）能把 tier 写进 frontmatter 持久化。
// upsert_row（.csv 行）/todo_add（清单行）/todo_done/remove_page 无 tier 粒度落点 → 见下方归一。
const TIER_BEARING_ACTIONS = new Set(['new_page', 'merge_into']);
// epistemic_type 白名单（spec §3.3）：这条内容「是什么性质的知识」。keeper 判时可选产出。
// 是描述性元数据、非门禁——白名单外/缺省一律归 null 放行，绝不因此拒件（假 provider/旧金标无此字段仍须过考卷）。
const EPISTEMIC_TYPES = new Set(['fact', 'preference', 'decision', 'opinion', 'excerpt', 'to-verify']);
// 骨架/流水区永久禁删（keeper 对 inbox 的清理走内部通路，不经 remove_page）
const NO_DELETE_ZONES = new Set(['governance', 'skills', 'inbox', 'keeper-feedback']);
const CANONICAL_SKILL_RE = /^skills\/([a-z0-9][a-z0-9._-]*)\/SKILL\.md$/;
const INCOMING_SKILL_RE = /^skills\/_incoming\/([a-z0-9][a-z0-9._-]*)\/SKILL\.md$/;

// 十/十一轮 Codex Minor：rollbackSchemaWrites 只删【本次 applySchema 亲手新建】的 zone 目录——用【一次性不可伪造 token】鉴权
// （比模块级 Set 更严：Set 按短 zoneDir key 判、跨实例/成功后残留旧授权，可误删既有两哨兵目录）。applySchema 落地成功即发一枚
// token（登记 {instanceDir, zoneDir}）并返回；rollbackSchemaWrites 必须【带 token】、消费即作废，且校验 instanceDir 一致；
// schemaApply 成功 commit 后 finalize 清账。token 唯一、消费/finalize 双清 → 无残留授权、无跨实例误删。
const pendingSchemaRollbacks = new Map(); // token -> { instanceDir, zoneDir }
export function finalizeSchemaRollback(token) { if (token) pendingSchemaRollbacks.delete(token); }

function today() {
  return new Date().toISOString().slice(0, 10);
}

function py(instanceDir, script, args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [script, ...args], { cwd: instanceDir, timeout: 60_000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(script)} 失败：${stderr || err.message}`)) : resolve(stdout)));
  });
}

function git(instanceDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: instanceDir, timeout: 30_000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} 失败：${stderr || err.message}`)) : resolve(stdout)));
  });
}

function nulPaths(raw) {
  return String(raw).split('\0').filter(Boolean);
}

// keeper 的复合写在专用 clone + 单写者队列里执行。正式落盘前要求工作树 clean，避免把人工/并发改动
// 混进本次归档；失败时只恢复本次产生的 tracked diff，并逐个删除本次新建的 untracked 文件。
// 不用 reset --hard / git clean，回滚面保持可枚举、可审计。
export async function assertCleanWorktree(instanceDir) {
  const status = await git(instanceDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const dirty = nulPaths(status);
  if (dirty.length) throw new Error(`实例工作树有 ${dirty.length} 处未提交改动，拒绝混入 keeper 归档`);
}

function outsideInbox(rel) {
  return rel !== 'inbox' && !rel.startsWith('inbox/');
}

export async function rollbackUncommitted(instanceDir) {
  // addEntry/resolveEntry 为了秒回，会先在 inbox/ 落盘、再排进 writer 队列。它们可能恰好发生在
  // clean 检查与 doctor 失败之间，因此统一回滚绝不能碰 inbox/；当前处理件由随后 holdEntry
  // 根据 entry.raw 重建，其余并发收件/裁定则保留给各自已排队的 commit。
  const staged = nulPaths(await git(instanceDir, ['diff', '--cached', '--name-only', '-z'])).filter(outsideInbox);
  if (staged.length) {
    // 先只退暂存区；这样 HEAD 中不存在的 staged-new 文件会变回 untracked，而不会让
    // `restore --source=HEAD --staged --worktree` 因无 HEAD 对象而中断整次回滚。
    await git(instanceDir, ['restore', '--staged', '--', ...staged]);
  }

  const tracked = nulPaths(await git(instanceDir, ['diff', '--name-only', '-z'])).filter(outsideInbox);
  if (tracked.length) {
    await git(instanceDir, ['restore', '--source=HEAD', '--worktree', '--', ...tracked]);
  }

  const untracked = nulPaths(await git(instanceDir, ['ls-files', '--others', '--exclude-standard', '-z']))
    .filter(outsideInbox);
  const root = path.resolve(instanceDir);
  for (const rel of untracked) {
    const abs = path.resolve(root, rel);
    if (abs === root || !abs.startsWith(root + path.sep)) {
      throw new Error(`回滚遇到越界 untracked 路径，拒绝删除：${rel}`);
    }
    if (existsSync(abs) && !statSync(abs).isDirectory()) rmSync(abs, { force: true });
  }
}

// doctor 迁自 keeper（Global Constraints：共用一处）。enabled=false → null；脚本不可用或输出不可解析也返回 null。
// keeper 的正式写路径会把「enabled=true 且 null」视为验收失败，fail closed；显式 doctor=false 的测试/调用方保持跳过。
export function runDoctor(instanceDir, { enabled = true } = {}) {
  if (!enabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('python3', [path.join(instanceDir, 'skills', 'substrate-doctor', 'doctor.py'), '.'],
      { cwd: instanceDir, timeout: 120_000, encoding: 'utf8' },
      (err, stdout) => {
        const matches = [...String(stdout).matchAll(/^\s*→ (\d+) error(?:\(s\)|s)?(?:\s*,.*)?\s*$/gm)];
        const errors = matches.length ? Number(matches.at(-1)[1]) : null;
        // doctor 发现错误时会以非零码退出，但汇总里的正数仍可信；基础设施失败却声称 0
        // 或根本没有汇总时一律不采信，交给调用方 fail closed。
        resolve(err && (!errors || errors === 0) ? null : errors);
      });
  });
}

// 从提案件【可见正文】取首个 ```json 块并 parse（schema 内容只认件自身——白名单原则）。无块/非法 JSON → null。
// 三轮加固（Codex 异源）：只认 parseEntryBody(raw).content（已剥掉 <!--keeper-options-->/<!--owner-decision--> 隐藏块），
// 不扫完整 raw。否则 approve-then-swap：approvalToken 绑的也是可见 content、会剥隐藏块，攻击者批准后往隐藏块塞一个
// 【更靠前】的恶意 ```json → token 仍验过、applySchema 却从完整 raw 取到隐藏 payload、落地被替换的 zone path/privacy。
// 改用可见正文后，取到的必是 approvalToken 绑定、主人看到的那份；往可见正文塞注入则 approvalToken 立即失配被拦。
// entry.body 本就是 parseEntryBody(raw).content（keeper 侧），工具侧只给 raw → 这里统一从 raw 重算可见正文。
// 取可见正文里【第一个 top-level（不在任何其它围栏/注释内）info === 'json' 的代码围栏】内容 verbatim 并 parse。
// 七轮 Codex：早先自成一套【只找 ```json、不跟踪外层非-json 围栏】的扫描 → 外层 ``` 代码块里【字面量】的 ```json（渲染上是
// 主人看的代码示例、非活动 payload）被当真 payload 执行、建 evil zone。改为复用 inbox.scanSegments（与 parseEntryBody.content
// 同一套 fence/comment 语义）：外层非-json 围栏内的 ```json 只是其文本、不是独立段；注释内的 ```json 也不算段。取第一个
// info='json' 的 top-level 围栏内容。无则 null → applySchema 拒件（白名单、安全失败）。二~六轮的隐藏块偷换（LF/CRLF/未闭合
// /行内 ``` desync）在同一套语义下一并闭合。
// 在【注释未剥】的原始正文上跑 scanSegments，取第一个 top-level kind==='fence' && info==='json' 的段（comment 段天然跳过）。
// 九轮 Codex：绝不能在【剥完注释】的字符串上找围栏——删注释会把 ``<!--x-->`json 拼成原文不存在的 ```json 活动围栏被误取。
function firstJsonFenceSeg(s) {
  for (const seg of scanSegments(s)) {
    if (seg.kind === 'fence' && seg.info === 'json') return seg;
  }
  return null;
}
function fenceInner(s, seg) {
  return seg ? s.slice(seg.innerStart, seg.innerEnd).replace(/\r?\n$/, '') : null;
}
function extractSchemaPayload(entry) {
  // 注释未剥的 scanBody（parseEntryBody 暴露）——scanSegments 把机器块/隐藏注释切成 comment 段跳过，且不因删注释合成假围栏。
  const pe = entry?.raw != null ? parseEntryBody(String(entry.raw)) : null;
  const scanBody = pe ? pe.scanBody : (entry?.scanBody ?? entry?.body ?? '');
  const execJson = fenceInner(String(scanBody), firstJsonFenceSeg(String(scanBody)));
  if (execJson == null) return null;
  if (pe != null) {
    const content = String(pe.content);
    const prevSeg = firstJsonFenceSeg(content);
    // ① 预览/执行一致（十一轮 Codex）：inbox_list 展示剥注释后的 content、执行取未剥的 scanBody。删注释若合成了排在前面的假围栏，
    //    主人预览到的 payload 会与执行的不一致（预览 visiblegood、落地 hiddenactive）→ 逐字不符即拒。真围栏在两串里内容逐字节相同。
    if (fenceInner(content, prevSeg) !== execJson) return null;
    // ② 预览窗口硬门禁（十二轮 Codex）：可执行 payload 的围栏必须【完整落在 inbox_list 预览窗口内】（seg.end ≤ 预览字数）。否则
    //    payload 被埋在预览截断之外（纯截断攻击）→ 主人预览不到却被落地。要求可见 → 拒掉「预览不到的 payload」。跨 keeper 点选/工具
    //    直调两通路统一在此收口（option label 不展示 payload，故只有绑定 target 不够）。
    if (!prevSeg || prevSeg.end > INBOX_PREVIEW_CHARS) return null;
  }
  try { return JSON.parse(execJson); } catch { return null; }
}

// schema 提案校验（propose 与 apply 重校验共用）：只认 payload 自身内容 + 此刻 zones 冲突。
// - id：/^[a-z][a-z0-9-]{1,30}$/
// - path：一级相对目录、以 / 结尾（如 health/）；不与现有 zone path 前缀互含（防覆盖既有子树或反向）
// - privacy：private|sensitive（缺省 private）
// 成功返回归一后的 { ok, id, path, purpose, privacy } 供 applySchema 直接落盘（审计与落盘同源）。
export function validateSchemaProposal({ instanceDir, payload }) {
  const p = payload ?? {};
  const id = typeof p.id === 'string' ? p.id : '';
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return { ok: false, reason: `zone id 不合法：${id}（须 /^[a-z][a-z0-9-]{1,30}$/）` };
  const zpath = typeof p.path === 'string' ? p.path : '';
  if (!/^[a-z][a-z0-9-]*\/$/.test(zpath)) return { ok: false, reason: `zone path 不合法：${zpath}（须一级相对目录、以 / 结尾，如 ${id}/）` };
  // 骨架/流水区（F2）：governance/skills/inbox/keeper-feedback 不是注册 zone、不被下方前缀检查覆盖——
  // 显式拒掉，防提案把骨架目录注册成 zone（覆写其 README、且 doctor-fail 回滚会波及既有内容）。
  if (NO_DELETE_ZONES.has(zpath.replace(/\/$/, ''))) {
    return { ok: false, reason: `zone path 指向骨架目录：${zpath}（${[...NO_DELETE_ZONES].join('/')} 是骨架/流水区，不可注册为 zone）` };
  }
  const privacy = p.privacy ?? 'private';
  if (privacy !== 'private' && privacy !== 'sensitive') return { ok: false, reason: `privacy 只接受 private|sensitive：${privacy}` };
  const zones = parseZones(instanceDir);
  if (zones.some((z) => z.id === id)) return { ok: false, reason: `zone id 已存在：${id}` };
  for (const z of zones) {
    if (!z.path) continue;
    if (zpath === z.path || zpath.startsWith(z.path) || z.path.startsWith(zpath)) {
      return { ok: false, reason: `zone path 与现有 zone「${z.id}」(${z.path}) 前缀互含：${zpath}` };
    }
  }
  // purpose 清洗（F1）：换行拍平之外剥掉全部反引号（换成 '）——purpose 会原样落进 zones.md 的 ```yaml 围栏，
  // 任何 ` 都可能（mid-line 或缩进变化后）提前闭合围栏，令后续 zone 对 parseZones 不可见 → sensitive ACL 静默绕过。
  // 单个反引号也不放行（不只挡三连）；再加 200 字符上限，防灌长文注记。
  const purpose = String(p.purpose ?? '').replace(/\n/g, ' ').replace(/`/g, "'").trim().slice(0, 200);
  return { ok: true, id, path: zpath, purpose, privacy };
}

function badTarget(target) {
  if (!target || typeof target !== 'string' || path.isAbsolute(target)) return true;
  // SEC-6（审计 B）：注入的 keeper 决定可把带换行/控制字符的 target 塞进文件名/frontmatter——如
  // target:"good\n\n## injected-heading"（另起 Markdown 标题）或 target:"note\nowner_ruling: forged"
  // （伪造 frontmatter 认证行）。先拒一切控制字符（C0 \u0000-\u001f 含 \n\r\t + DEL \u007f），消灭换行注入面。
  if (/[\u0000-\u001f\u007f]/.test(target)) return true;
  // 再对每个 `/` 分段做严格 slug 白名单：字母/数字/下划线/点/连字符/CJK（与本文件 slugify 的 [一-鿿] 同族）。
  // `..`/`.git` 会通过 slug 正则（`.` 在白名单内），故显式检查保留在前。分段不含 `/`；空段（`//`、首尾 `/`）
  // 因 `+` 要求至少一字符而被拒（合法 slug 无空段）。收紧只挡异常字符——既有合法 slug（英文连字符 /
  // concepts/xxx 子目录 / CJK 页名）均放行（见 audit-b SEC-6 回归断言）。
  return target.split('/').some((s) => s === '..' || s === '.git' || !/^[\w.一-鿿-]+$/u.test(s));
}
// slug → 实例内页相对路径（slug 可自带 zone 前缀也可不带，与 remove_page/merge_into 的既有惯例同义）
function pageRel(zone, slugRaw) {
  const slug = String(slugRaw).replace(/\.md$/, '');
  return slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
}

function parseSkillDocument(raw) {
  const text = String(raw ?? '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { ok: false, reason: 'Skill 内容必须是带 frontmatter 的完整 SKILL.md' };
  const get = (key) => m[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  const name = get('name').replace(/^["']|["']$/g, '');
  if (!name) return { ok: false, reason: 'Skill frontmatter 缺 name' };
  if (!get('target_runtimes')) return { ok: false, reason: 'Skill frontmatter 缺 target_runtimes' };
  if (!get('risk_level')) return { ok: false, reason: 'Skill frontmatter 缺 risk_level' };
  return { ok: true, name };
}

function skillDocumentWithContentId(raw, contentId) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) throw new Error('Skill 内容必须是带 frontmatter 的完整 SKILL.md');
  const fm = m[1].split('\n').filter((line) => !/^\s*content_id\s*:/.test(line));
  const rest = text.slice(m[0].length);
  return `---\ncontent_id: ${contentId}\n${fm.join('\n')}\n---\n${rest}`;
}

// 决定合法性校验（代码层，模型说什么不算数）
export function validateDecision({ instanceDir, decision, entry }) {
  const d = decision ?? {};
  if (!DISPOSITIONS.has(d.disposition)) return { ok: false, reason: `disposition 不合法：${d.disposition}` };
  // core 提案连“丢弃”也是治理决定（会清场提案、改变下次是否重提），统一要求服务端亲生 + 主频道高信任批准；
  // 这道门须在 forbidden 早返回之前，否则非主频道可借 forbidden 清掉 core 提案。
  if (entry?.kind === 'core') {
    if (!entry.__native) return { ok: false, reason: 'core 提案只接受服务端亲生且未被篡改的件' };
    if (!entry.__ruling_authentic) return { ok: false, reason: 'core 提案需已认证的主人点选裁定' };
    if (entry.__ruling_trust !== 'high' || entry.__ruling_channel !== 'primary') {
      return { ok: false, reason: 'core 提案只能由高信任主频道裁定' };
    }
  }
  if (d.disposition === 'forbidden') return { ok: true, verdict: 'reject', reason: d.reject_reason || '按宪法禁止入库' };
  if (d.disposition === 'local-only') return { ok: false, reason: 'local-only 在服务端无意义（无本地），需主人定夺' };
  // replace_skill 是 keeper 代码根据【服务端亲生/主人已认证】件中的显式 path/content_id 意图派生出的内部动作，
  // 不在模型 ACTIONS 白名单里。模型直接产同名动作、或 target 与代码解析到的真实页不一致，一律拒。
  if (d.action === 'replace_skill') {
    if (d.disposition !== 'canonical') return { ok: false, reason: 'replace_skill 只接受 canonical disposition' };
    if (typeof d.confidence !== 'number' || !d.summary) return { ok: false, reason: 'replace_skill 缺 confidence 或 summary' };
    const intent = entry?.__page_intent;
    if (!intent || intent.kind !== 'existing' || !intent.trusted) {
      return { ok: false, reason: 'replace_skill 只接受代码解析并认证过的现有页更新意图' };
    }
    if (d.zone !== 'skills' || d.target !== intent.rel || !CANONICAL_SKILL_RE.test(intent.rel)) {
      return { ok: false, reason: 'replace_skill 只能原位替换 skills/<name>/SKILL.md 的真实路径' };
    }
    const doc = parseSkillDocument(entry?.body);
    const expectedName = intent.rel.match(CANONICAL_SKILL_RE)?.[1];
    if (!doc.ok) return doc;
    if (doc.name !== expectedName) return { ok: false, reason: `Skill name（${doc.name}）与目标目录（${expectedName}）不一致` };
    const zones = parseZones(instanceDir);
    const zone = zones.find((z) => z.id === 'skills');
    if (!zone) return { ok: false, reason: 'skills zone 不存在' };
    if (!existsSync(path.join(instanceDir, intent.rel))) return { ok: false, reason: `目标页不存在：${intent.rel}` };
    return { ok: true, verdict: 'file', zone };
  }
  // D1（M4.6）安全边界：set_tier 绝不能从 LLM decision 触达——注入可诱导 keeper 把任意页降级=软删除，绕过
  // remove_page 的裁定保护。降级只走两个确定性入口（夜班进程内 / 高信任 page_set_tier），均直调 setPageTier、
  // 不经本校验。显式早拒（不只依赖「不在 ACTIONS 白名单」——防未来误把它并进白名单静默开洞）。
  if (d.action === 'set_tier') {
    return { ok: false, reason: 'set_tier 不是 keeper 可产出的动作（降级只在夜班进程内确定性执行；恢复请用高信任 page_set_tier 工具）' };
  }
  // _core 是 always-load 的高权限派生面：普通 ACTIONS/LLM 永远触达不了，只有服务端亲生 core 提案
  // 经高信任主人点选后，才能走 calibrate_core 整页替换。decision 只指向可见草案并绑定 hash，不能夹带正文。
  if (d.action === 'calibrate_core') {
    if (d.disposition !== 'canonical') return { ok: false, reason: 'calibrate_core 只接受 canonical disposition' };
    if (typeof d.confidence !== 'number' || !d.summary) return { ok: false, reason: 'calibrate_core 缺 confidence 或 summary' };
    if (entry?.kind !== 'core') return { ok: false, reason: `calibrate_core 仅用于 core 提案件；本件 kind=${entry?.kind ?? '未知'}` };
    if (!entry?.__native) return { ok: false, reason: 'calibrate_core 只接受服务端亲生且未被篡改的 core 提案' };
    if (!entry?.__ruling_authentic) return { ok: false, reason: 'calibrate_core 需已认证的主人点选批准' };
    if (entry?.__ruling_trust !== 'high') return { ok: false, reason: 'calibrate_core 只能由高信任客户端批准' };
    if (entry?.__ruling_channel !== 'primary') return { ok: false, reason: 'calibrate_core 只能由主频道批准' };
    if (d.zone !== 'memory' || d.target !== '_core') return { ok: false, reason: 'calibrate_core 只能整页替换 memory/about-owner/_core.md' };
    let draft;
    try { draft = extractCoreDraft(entry); }
    catch (e) { return { ok: false, reason: `core 可见草案校验失败：${e.message}` }; }
    if (d.draft_hash !== draft.hash) return { ok: false, reason: 'calibrate_core 的隐藏决定与主人可见草案 hash 不符' };
    const zones = parseZones(instanceDir);
    const zone = zones.find((z) => z.id === 'memory');
    if (!zone) return { ok: false, reason: 'memory zone 不存在' };
    return { ok: true, verdict: 'file', zone };
  }
  if (!ACTIONS.has(d.action)) return { ok: false, reason: `action 不合法：${d.action}` };
  if (typeof d.confidence !== 'number' || !d.summary) return { ok: false, reason: '缺 confidence 或 summary' };
  // 分层白名单（spec §6.1）：模型只能产出 canonical|candidate；缺省视为 canonical（向后兼容）。
  // 非法值（如被注入产出 tier: rejected / admin）→ 拒（落 held），rejected 只能由 keeper 判 forbidden 后代码落。
  if (d.tier !== undefined && d.tier !== null && !DECISION_TIERS.has(d.tier)) {
    return { ok: false, reason: `tier 不合法：${d.tier}（只接受 canonical|candidate，缺省视为 canonical）` };
  }
  // 缺陷3：对无法持久化 tier 的 action，把 candidate 归一为 canonical（CSV/todo 行本就默认可见）——
  // 就地改写 decision.tier，使 keeper 审计记录的 tier/disposition = 实际落盘的 tier（审计不说谎）。
  // 不搞行级 tier（过度设计）。candidate 只对 new_page/merge_into 有意义。
  if (d.tier === 'candidate' && !TIER_BEARING_ACTIONS.has(d.action)) d.tier = 'canonical';
  // epistemic_type 归一（与 tier 归一同款、就地改写 d.epistemic_type）：白名单外/缺省 → null。
  // 与 tier 的关键区别：tier 非法要拒件（越权风险），epistemic_type 只是描述性元数据——非法一律归 null
  // 放行、绝不拒件（元数据容错 §3.3）。就地改写令 keeper 审计记录的 decision = 实际落盘（审计不说谎）。
  d.epistemic_type = EPISTEMIC_TYPES.has(d.epistemic_type) ? d.epistemic_type : null;

  const zones = parseZones(instanceDir);
  // schema_apply（D2b，放 remove_page 同级但需先于通用 zone 查找——它的 zone 字段是占位、不查注册表）：
  // 白名单原则——decision 无法携带 schema 内容，只能「指向」提案件（target=payload.id 一致才 ok），且仅 schema 件能触发。
  // zone 字段容忍任意（提案自证）；返回占位 zone（applySchema 忽略它，直改 governance/zones.md）。
  if (d.action === 'schema_apply') {
    if (entry?.kind !== 'schema') return { ok: false, reason: `schema_apply 仅用于 schema 提案件；本件 kind=${entry?.kind ?? '未知'}` };
    // F1：建 zone 是治理动作，须【认证过】的主人批准（keeper 已在未认证时作废 approved_decision → 走不到这里；
    // 此为防御性二道门，挡住任何绕过 keeper 认证直调 validateDecision 的未来路径）。工具入口 schema_apply
    // 由 bearer+high 授权、直调 applySchema 不经此校验，不受影响。
    if (!entry?.__ruling_authentic) return { ok: false, reason: 'schema_apply 需已认证的主人批准（点选提案候选）' };
    const payload = extractSchemaPayload(entry);
    if (!payload || d.target !== payload.id) {
      return { ok: false, reason: `schema_apply 的 target（${d.target}）须指向本提案件的 zone id（payload.id）` };
    }
    return { ok: true, verdict: 'file', zone: zones.find((z) => z.id === 'governance') ?? zones[0] };
  }
  const zone = zones.find((z) => z.id === d.zone);
  if (!zone) return { ok: false, reason: `zone 不存在：${d.zone}（可用：${zones.map((z) => z.id).join('、')}）` };

  if (d.action === 'todo_add') {
    if (d.zone !== 'todo') return { ok: false, reason: 'todo_add 只能进 todo 区' };
  } else if (d.action === 'todo_done') {
    if (d.zone !== 'todo') return { ok: false, reason: 'todo_done 只能作用于 todo 区' };
    if (!d.target?.trim()) return { ok: false, reason: 'todo_done 缺 target（待办条目原文）' };
  } else if (d.action === 'remove_page') {
    if (NO_DELETE_ZONES.has(d.zone)) return { ok: false, reason: `禁删区：${d.zone}（骨架/流水区不允许经服务删除）` };
    // 硬校验爆炸半径（spec §7）：remove_page 只允许「删除件（kind=remove）」或「主人裁定过的件」。
    // F1：裁定的真实性只认进程内批准登记表（keeper 查表命中才置 entry.__ruling_authentic），不再信文件里
    // 裸的 owner_ruling / ruling_via_trust（git pull 可伪造这些 frontmatter 字段绕过本门）。普通 capture/save
    // 伪造件即便带 owner_ruling，未经 resolveEntry 记账 → __ruling_authentic=false → 在此拦下。
    const rulingMarked = !!entry?.__ruling_authentic;
    // SEC-2（审计 B §4）：kind=remove 旁路必须【额外】要求件是服务端亲生的（entry.__native）。核心洞察——
    // 「认证『主人动过手』≠ 认证『件是服务端亲生的』」：旧码只看 kind==='remove' 即短路认证，而 kind 是
    // frontmatter 里 git pull 可任意伪造的字段——伪造件写 kind: remove 即被 keeper 洗成合法删页（零交互删任意页）。
    // __native 由 keeper.processEntry 按【内容绑定 token】复算置（nativeReg.get(id)===nativeToken(当前件)），只有本
    // 进程 addEntry 亲手造【且未被篡改】的合法删除件才 __native=true；git pull 伪造件从不经 addEntry、即便复用某个
    // 公开的历史 native id，其正文/kind 与登记 token 不符 → 失配 → nativeRemove=false → 挡下（二轮加固：一轮只按
    // id 判 native 被公开 id 复用打穿）。重启语义：nativeReg 是进程内状态、重启即空——重启前造的 remove 件重启后处理
    // 会因非 native 落 held（安全失败，主人重发 remove 即可），与 approvals 批准登记表的重启语义同族、一致。
    const nativeRemove = entry?.kind === 'remove' && !!entry?.__native;
    if (!nativeRemove && !rulingMarked) {
      return { ok: false, reason: `remove_page 仅用于服务端生成的删除件（kind=remove）或主人明确裁定；本件 kind=${entry?.kind ?? '未知'} 且无认证的主人裁定，不予删除（需主人确认）` };
    }
    // 通道限权也只认 registry 里的 viaTrust（keeper 置 entry.__ruling_trust）：capture 通道（App 最低档）
    // 的裁定无权删页——伪造件改写文件里的 ruling_via_trust 无效。
    if (entry?.__ruling_trust === 'capture') {
      return { ok: false, reason: 'capture 通道（App）的裁定无权删除页面——删页请在高信任客户端（CC/Hermes）发起' };
    }
    if (badTarget(d.target)) return { ok: false, reason: `target 不合法：${d.target}` };
    const slug = d.target.replace(/\.md$/, '');
    const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
    if (path.basename(rel) === 'README.md' || path.basename(rel).startsWith('_')) {
      return { ok: false, reason: `不允许删结构页：${rel}` };
    }
    if (!existsSync(path.join(instanceDir, rel))) return { ok: false, reason: `目标页不存在：${rel}（不误删，需主人确认）` };
  } else if (d.action === 'merge_pages') {
    // 夜班维护合并（M4.4 D3）会删源页——与 remove_page 同级硬校验：只认主人裁定过的件（点选提案候选
    // 即写 owner_ruling），数据/模型输出永不触发；且不设 kind 旁路（它还会改写目标页，比纯删更宽的改动面）。
    if (NO_DELETE_ZONES.has(d.zone)) return { ok: false, reason: `禁删区：${d.zone}（骨架/流水区不允许合并删页）` };
    // F1：与 remove_page 同——只认认证过的批准（进程内登记表），不信裸 owner_ruling/ruling_via_trust。
    const rulingMarked = !!entry?.__ruling_authentic;
    if (!rulingMarked) {
      return { ok: false, reason: 'merge_pages 会删源页，仅在主人明确裁定（点选提案）后执行；本件无认证的主人裁定，不予执行' };
    }
    // 与 remove_page 同款通道限权（只认 registry 里的 viaTrust）：capture 通道无权触发删页类动作
    if (entry?.__ruling_trust === 'capture') {
      return { ok: false, reason: 'capture 通道（App）的裁定无权触发合并删页——请在高信任客户端（CC/Hermes）批准' };
    }
    for (const [role, val] of [['source', d.source], ['target', d.target]]) {
      if (badTarget(val)) return { ok: false, reason: `${role} 不合法：${val}` };
      const rel = pageRel(zone, val);
      if (path.basename(rel) === 'README.md' || path.basename(rel).startsWith('_')) {
        return { ok: false, reason: `不允许动结构页：${rel}（merge_pages 的 ${role}）` };
      }
      if (!existsSync(path.join(instanceDir, rel))) return { ok: false, reason: `${role} 页不存在：${rel}（不误动，需主人确认）` };
    }
    if (pageRel(zone, d.source) === pageRel(zone, d.target)) {
      return { ok: false, reason: 'merge_pages 的 source 与 target 是同一页，无从合并' };
    }
  } else if (d.action === 'upsert_row') {
    if (badTarget(d.target) || d.target.includes('/')) return { ok: false, reason: `收藏名不合法：${d.target}` };
    if (!existsSync(path.join(instanceDir, 'collections', d.target, 'data.csv'))) {
      return { ok: false, reason: `收藏不存在：${d.target}` };
    }
    if (!d.fields || typeof d.fields !== 'object') return { ok: false, reason: 'upsert_row 缺 fields' };
  } else if (d.action === 'new_page' || d.action === 'merge_into') {
    if (badTarget(d.target)) return { ok: false, reason: `target 不合法：${d.target}` };
    const rel = pageRel(zone, d.target);
    if (path.basename(rel) === 'README.md' || path.basename(rel).startsWith('_')) {
      return { ok: false, reason: `普通 keeper 写动作不允许触碰结构页：${rel}` };
    }
    if (d.zone === 'skills' && d.action === 'new_page') {
      const hit = rel.match(INCOMING_SKILL_RE);
      if (!hit) return { ok: false, reason: '新 Skill 必须先写入 skills/_incoming/<name>/SKILL.md' };
      const doc = parseSkillDocument(entry?.body);
      if (!doc.ok) return doc;
      if (doc.name !== hit[1]) return { ok: false, reason: `Skill name（${doc.name}）与目标目录（${hit[1]}）不一致` };
    }
  } else {
    if (badTarget(d.target)) return { ok: false, reason: `target 不合法：${d.target}` };
  }
  return { ok: true, verdict: 'file', zone };
}

export async function applyDecision({ instanceDir, entry, decision, zone }) {
  switch (decision.action) {
    case 'todo_add': return todoAdd(instanceDir, entry);
    case 'todo_done': return todoDone(instanceDir, decision);
    case 'upsert_row': return upsertRow(instanceDir, decision);
    case 'new_page': return newPage(instanceDir, entry, decision, zone);
    case 'merge_into': return mergeInto(instanceDir, entry, decision, zone);
    case 'replace_skill': return replaceSkill(instanceDir, entry, decision);
    case 'remove_page': return removePage(instanceDir, decision, zone);
    case 'merge_pages': return mergePages(instanceDir, decision, zone);
    case 'schema_apply': return applySchema({ instanceDir, entry }); // zone 参数忽略——schema 内容只从件正文取
    case 'calibrate_core': return applyCoreCalibration({ instanceDir, entry }); // 特权整页替换；正文只取主人可见 core 草案
    default: throw new Error(`未知 action：${decision.action}`);
  }
}

// applySchema（D2b）：工具入口与 keeper approved_decision 入口共用。确定性三步 + doctor 校验 + errors>0 显式回滚。
// 内容只从提案件正文的 ```json 块取（重解析+重校验），绝不从 decision JSON 取——LLM/裁定无法凭空造 zone。
// 不 commit（由调用方在 writer.transact 内移除提案件一并提交）；回滚时 git checkout + rm 新目录后 throw。
export async function applySchema({ instanceDir, entry }) {
  const rel = entry.rel ?? entry.path;
  const raw = readFileSync(path.join(instanceDir, rel), 'utf8');
  const payload = extractSchemaPayload({ raw });
  if (!payload) throw new Error('schema 提案件正文缺可解析的 ```json 块');
  // 重校验（同 propose 规则 + 此刻 zones 冲突）：propose 到 apply 之间 zones 可能已被别的提案改动。
  const v = validateSchemaProposal({ instanceDir, payload });
  if (!v.ok) throw new Error(v.reason);
  // F2 双保险：目标目录已存在 → 在动任何文件之前拒。骨架区已被 validateSchemaProposal 拦；这条防「未来被
  // 解注册/漏网的既有目录」被覆写。由此不变量成立：能走到下方回滚时，dirAbs 必为本次新建——rmSync 永不删既有树。
  const dirAbs = path.join(instanceDir, v.path);
  if (existsSync(dirAbs)) throw new Error(`zone 目录已存在：${v.path}（schema_apply 只建全新目录，不覆写既有内容）`);

  const zonesRel = 'governance/zones.md';
  const zonesAbs = path.join(instanceDir, zonesRel);
  const zonesRaw = readFileSync(zonesAbs, 'utf8');
  const fence = /(```yaml\n[\s\S]*?\n)(```)/; // 与 acl.parseZones 同锚点；在闭合 ``` 前插入新条目
  if (!fence.test(zonesRaw)) throw new Error('governance/zones.md 里找不到 yaml 块');
  const block = [
    `  - id: ${v.id}`,
    `    path: ${v.path}`,
    `    purpose: ${v.purpose}`,
    `    schema: ${v.id}-zone-v1`,
    '    maintainer_skill: substrate-curator',
    '    readers: [all]',
    '    writers: [all]',
    '    disposition: canonical',
    `    privacy: ${v.privacy}`,
    '',
  ].join('\n');
  writeFileSync(zonesAbs, zonesRaw.replace(fence, `$1${block}$2`));
  // 建 zone 目录 + .gitkeep（空目录占位）+ README stub
  mkdirSync(dirAbs, { recursive: true });
  writeFileSync(path.join(dirAbs, '.gitkeep'), '');
  writeFileSync(path.join(dirAbs, 'README.md'), `# ${v.id}\n\n${v.purpose}\n`);

  // doctor 校验（enabled:true——schema 落地的验收就是 doctor 0 error）。无结果或 errors>0 都回滚、不 commit、throw。
  const errors = await runDoctor(instanceDir, { enabled: true });
  if (errors === null || errors > 0) {
    await git(instanceDir, ['checkout', '--', zonesRel]); // 撤回 zones.md 追加（回到 HEAD，本 transact 前已 commit）
    // 只删「本次新建」：上方已存在即拒的守卫保证 dirAbs 必为本次 mkdirSync 所建，递归删不可能波及既有树。
    rmSync(dirAbs, { recursive: true, force: true });
    throw new Error(errors === null ? 'doctor 未返回可解析结果，已回滚' : `doctor 报 ${errors} error，已回滚`);
  }
  // 发一枚一次性 rollback token（登记本次新建目录 + 实例）——doctor 通过后才发，故 doctor-fail 路径（上方自回滚+throw）不留 token。
  const rollbackToken = randomBytes(16).toString('hex');
  pendingSchemaRollbacks.set(rollbackToken, { instanceDir, zoneDir: path.dirname(`${v.path}README.md`) });
  return {
    changedPaths: [zonesRel, `${v.path}README.md`, `${v.path}.gitkeep`],
    detail: `zone ${v.id} 已建（${v.path}）`,
    zoneId: v.id,
    rollbackToken,
  };
}

// 五轮加固（Codex Minor#2）：applySchema 落盘（改 zones.md + 建 zone 目录）成功、但调用方 writer.transact 内随后的
// commit 失败（如提案件未 tracked → git add pathspec 报错）时，transact 无回滚 → 半落地的孤儿 zone。此助手撤回 zones.md、删
// 本次新建 zone 目录、恢复提案件。整体【只在 applySchema 发的一次性 token 命中且 instanceDir 一致时】才动手——既有目录/跨实例/
// 成功后残留/伪 token 都无有效授权 → 全函数 no-op（十二轮 Codex：连 zones.md 的 checkout 都不能碰，否则误调会丢本地未提交改动）。
// token 消费即作废，删目录叠加形状守卫（恰两哨兵）作纵深防御。changedPaths 仅用于兼容/日志。
export async function rollbackSchemaWrites({ instanceDir, changedPaths, rollbackToken, entryRel, entryRaw }) {
  if (!rollbackToken) return;
  const pending = pendingSchemaRollbacks.get(rollbackToken);
  pendingSchemaRollbacks.delete(rollbackToken); // 消费即作废（即便 instanceDir 不符也烧掉），防 token 重用
  if (!pending || pending.instanceDir !== instanceDir) return; // 无效/跨实例 token → 彻底 no-op，绝不触碰 zones.md/目录/件
  await git(instanceDir, ['checkout', '--', 'governance/zones.md']).catch(() => {}); // 撤回本次 zones.md 追加（回到 HEAD）
  const dirAbs = path.join(instanceDir, pending.zoneDir);
  const dirFiles = existsSync(dirAbs) ? readdirSync(dirAbs) : [];
  if (dirFiles.length === 2 && dirFiles.includes('README.md') && dirFiles.includes('.gitkeep')) {
    rmSync(dirAbs, { recursive: true, force: true });
  }
  if (entryRel) {
    const abs = path.join(instanceDir, entryRel);
    await git(instanceDir, ['checkout', '--', entryRel]).catch(() => {}); // 件 tracked → 恢复到 HEAD
    // 五轮 Codex Minor：件 untracked（本地未提交提案）时 checkout 无从恢复——调用方在 rmSync 前存了原文 entryRaw，写回杜绝丢失。
    if (!existsSync(abs) && entryRaw != null) writeFileSync(abs, entryRaw);
  }
}

// setPageTier（M4.6 D1）：非破坏性降级/晋升——把页 frontmatter 的 tier 在 canonical↔candidate 之间互翻。
// 硬校验（测试必须覆盖）：① 目标档只认 canonical|candidate——rejected 相关一律拒（rejected 仍走既有裁定
// 通路，删除/隔离要主人裁定，降级永不产 rejected）；② 骨架/流水区页拒（governance/skills/inbox/keeper-feedback
// 无分层语义、且是删禁区）；③ 结构页（README/_ 前缀）与越界路径拒；④ 页不存在报错、不落地（不误改）。
// 纯同步、不 commit：调用方（夜班 / page_set_tier 工具）在 writer.transact 内拿 changedPaths 提交。返回 from/to
// 供审计如实记录降级前后档位（审计=落盘事实）。page 接受带/不带 .md 的实例内相对路径（与 remove_page 同族）。
export function setPageTier({ instanceDir, page, tier }) {
  const target = String(tier ?? '').trim().toLowerCase();
  if (!SET_TIER_TARGETS.has(target)) {
    return { ok: false, reason: `set_tier 目标档只认 canonical|candidate：${tier}（rejected 仍走裁定通路，不由 set_tier 产出）` };
  }
  if (badTarget(page)) return { ok: false, reason: `page 不合法：${page}` };
  const rel = String(page).endsWith('.md') ? String(page) : `${page}.md`;
  // 骨架/流水区（与 remove_page 同一 NO_DELETE_ZONES）：这些区不是分层对象，且是删禁区——不允许 set_tier
  // 碰它们（否则 page_set_tier 高信任工具或夜班误传即可给 governance/inbox 页乱打 tier）。
  if (NO_DELETE_ZONES.has(rel.split('/')[0])) {
    return { ok: false, reason: `骨架/流水区页不参与分层：${rel}（${[...NO_DELETE_ZONES].join('/')} 不可 set_tier）` };
  }
  const base = path.basename(rel);
  if (base === 'README.md' || base.startsWith('_')) {
    return { ok: false, reason: `不允许对结构页 set_tier：${rel}` };
  }
  const abs = path.join(instanceDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, reason: `目标页不存在：${rel}（不误改，请确认路径）` };
  }
  const raw = readFileSync(abs, 'utf8');
  const from = readTier(raw);
  // 只翻 tier 行，不动 updated——降级是元数据操作、页内容未变；且降级恰恰针对陈旧/薄页，刷新 updated 会抹掉
  // 「N 周未更新」的陈旧信号（recall gaps 依赖它）。setTierLine 严格限定改 frontmatter 块内的 tier 行。
  writeFileSync(abs, setTierLine(raw, target));
  return { ok: true, changedPaths: [rel], page: rel, from, to: target };
}

// merge_pages（M4.4 D3）：源页正文并入目标页 + 删源页清全库反链，一个原子动作。
// 与 merge_into 的本质区别：并入的是【源页正文】而非 entry.body——对夜班提案件，body 是提案文案，贴进去语义全错。
async function mergePages(instanceDir, decision, zone) {
  const srcRel = pageRel(zone, decision.source);
  const tgtRel = pageRel(zone, decision.target);
  const srcAbs = path.join(instanceDir, srcRel);
  const tgtAbs = path.join(instanceDir, tgtRel);
  const srcRaw = readFileSync(srcAbs, 'utf8');
  // F3：落盘前快照 target（源页正文 srcRaw 已在手，兼作源页快照）——curate rm 任一步失败即据此回滚。
  const tgtOriginal = readFileSync(tgtAbs, 'utf8');
  // 源页去 frontmatter 的正文并入；tier 沿 mergeInto 的「分层不降级」规则，但比较的是【两页自身档位】
  // （合并页的分层语义来自页，不来自 decision——夜班提案不产 tier，decision.tier 在此无意义、径直忽略）。
  const srcBody = srcRaw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  let text = tgtOriginal;
  const srcTier = readTier(srcRaw);
  const curTier = readTier(text);
  const effTier = TIER_RANK[srcTier] > TIER_RANK[curTier] ? srcTier : curTier;
  text = text.replace(/^updated: .*$/m, `updated: ${today()}`);
  // 与 mergeInto 同规矩：仅档位非 canonical 或页上本就有显式 tier 行才写，不给存量页凭空加行
  if (effTier !== 'canonical' || hasExplicitTier(text)) text = setTierLine(text, effTier);
  text += `\n\n---\n\n**${today()} 夜班合并**（自 ${srcRel}）：\n\n${srcBody}\n`;
  writeFileSync(tgtAbs, text);
  // 先写合并再删源：curate rm 会清全库反链（可能就地改到目标页与【第三方页反链】），后删保证反链清理结果不被上面的写覆盖。
  // F3/G3：rm 失败/超时 → 显式回滚再抛，令 merge_pages 成原子动作（要么全成、要么原样），不留未批准的「半并」/
  // 脏第三方页给读工具或后续 paths:['.'] 整树提交误带。curate rm 的改动面不止 source/target——它会就地改任何
  // 引用源页的第三方页反链，故须【整树】回滚：git checkout -- .（scope 到 instanceDir）恢复所有 tracked 改动
  // （第三方页反链 + source 删除 + target 追加），镜像 applySchema 的 git checkout 回滚。守卫：非 git 目录
  // （executor 单元测试临时目录，无 .git）回退到 source/target 快照恢复（该场景 curate 只改这两页）。
  // H2：回滚 checkout 排除 inbox/——「单写者」不变量已被违反：resolveEntry 在进 writer 队列前就 writeFileSync
  // 了 tracked inbox 件（写在前、commit 排队在后）。curate rm 只改内容页（source/target/第三方反链），从不碰
  // inbox；整树 checkout 却会把并发的、尚未提交的批准写（owner_ruling+status:pending）抹回 HEAD。排除 inbox
  // 既充分（内容页照样回滚）又安全（不误清并发批准）。`:(exclude)inbox` pathspec magic（git ≥1.9）。
  try {
    await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
      ['rm', '--instance', '.', '--page', srcRel, '--apply']);
  } catch (e) {
    if (existsSync(path.join(instanceDir, '.git'))) {
      try { await git(instanceDir, ['checkout', '--', '.', ':(exclude)inbox']); } catch { /* 尽力整树回滚（排除 inbox：不误清并发的队列外批准写）*/ }
    } else {
      try { writeFileSync(tgtAbs, tgtOriginal); } catch { /* 尽力回滚 target */ }
      try { writeFileSync(srcAbs, srcRaw); } catch { /* 尽力回滚源页 */ }
    }
    throw new Error(`merge_pages 落盘失败已回滚（整树恢复原样）：${e.message}`);
  }
  // rm 改动面不可预知 → 整树提交，沿 removePage 惯例
  return { changedPaths: ['.'], detail: `${srcRel} 并入 ${tgtRel}` };
}

async function removePage(instanceDir, decision, zone) {
  const slug = decision.target.replace(/\.md$/, '');
  const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
    ['rm', '--instance', '.', '--page', rel, '--apply']);
  // rm 会清全库反向链接 + 重建索引，改动面不可预知 → 整树提交（写者串行，窗口内无并发写）
  return { changedPaths: ['.'], detail: rel };
}

function todoAdd(instanceDir, entry) {
  const rel = 'todo/owner.md';
  const abs = path.join(instanceDir, rel);
  const text = readFileSync(abs, 'utf8');
  const m = text.match(/^## 待办\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) throw new Error('todo/owner.md 里找不到「## 待办」小节');
  const section = m[1];
  const numbers = [...section.matchAll(/^(\d+)\./gm)].map((x) => Number(x[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const insertAt = m.index + m[0].length;
  const line = `${next}. ${entry.body.trim()}\n`;
  const glue = m[0].endsWith('\n\n') ? '' : '\n';
  writeFileSync(abs, text.slice(0, insertAt) + (m[0].endsWith('\n') ? '' : '\n') + line + glue + text.slice(insertAt));
  return { changedPaths: [rel], detail: `todo/owner.md 第 ${next} 条` };
}

// 有界改动：把「进行中/待办」里唯一匹配的一条挪进「已完成」（- 原文 ✅ 日期，实例既有格式）
function todoDone(instanceDir, decision) {
  const rel = 'todo/owner.md';
  const abs = path.join(instanceDir, rel);
  const text = readFileSync(abs, 'utf8');
  const needle = decision.target.trim();
  const lines = text.split('\n');
  const matches = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^## (进行中|待办)/.test(lines[i])) { inSection = true; continue; }
    if (/^## /.test(lines[i])) { inSection = false; continue; }
    if (!inSection) continue;
    const itemText = lines[i].replace(/^(\d+\.|-)\s+/, '').trim();
    if (itemText && (itemText === needle || itemText.includes(needle))) matches.push({ i, itemText });
  }
  if (matches.length !== 1) {
    throw new Error(`todo_done 目标须唯一匹配，「${needle}」命中 ${matches.length} 条——请主人指明是哪条`);
  }
  const { i, itemText } = matches[0];
  lines.splice(i, 1);
  let out = lines.join('\n');
  if (!/^## 已完成/m.test(out)) out = out.replace(/\n*$/, '\n\n## 已完成\n');
  out = out.replace(/^## 已完成\n/m, `## 已完成\n\n- ${itemText} ✅ ${today()}\n`)
    .replace(/\n{4,}/g, '\n\n\n');
  writeFileSync(abs, out.replace(/^updated: .*$/m, `updated: ${today()}`));
  return { changedPaths: [rel], detail: `todo 完成：${itemText.slice(0, 40)}` };
}

async function upsertRow(instanceDir, decision) {
  const fields = { ...decision.fields };
  if (!fields.id) fields.id = slugify(fields.name ?? `${decision.target}-${Date.now().toString(36)}`);
  if (!fields.added_date) fields.added_date = today();
  fields.updated_date = today();
  const csvRel = `collections/${decision.target}/data.csv`;
  const args = ['upsert', '--csv', csvRel, '--apply'];
  for (const [k, v] of Object.entries(fields)) args.push('--field', `${k}=${String(v).replace(/\n/g, ' ')}`);
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-collections', 'collections.py'), args);
  return { changedPaths: [csvRel], detail: `${decision.target} 行 ${fields.id}` };
}

async function newPage(instanceDir, entry, decision, zone) {
  const rel = pageRel(zone, decision.target);
  const abs = path.join(instanceDir, rel);
  const slug = path.posix.basename(rel, '.md');
  if (existsSync(abs)) throw new Error(`页已存在：${rel}（该用 merge_into）`);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (INCOMING_SKILL_RE.test(rel)) {
    writeFileSync(abs, skillDocumentWithContentId(entry.body, newContentId()));
    return { changedPaths: [rel], detail: rel };
  }
  const fm = [
    '---',
    `content_id: ${newContentId()}`, // 稳定短 id：落盘即写，扛改名（spec §6.1）
    `tier: ${normTier(decision.tier)}`, // 分层：高置信 canonical / 价值可疑 candidate（缺省 canonical）
    // 单行安全依赖 inbox.js：client 写入过 oneline()、读回是行锚定正则——若换多行感知解析器需重审这行
    `source_agent: ${entry.client}`, // 溯源：谁提的（spec §3.3）
    `confidence: ${decision.confidence}`, // 置信：keeper 判时多有把握
    // 认知类型仅白名单值才写（validateDecision 已归一为白名单或 null；此处再过白名单=tier 的 normTier 同款
    // 二次兜底——万一未来出现绕开 validateDecision 直调 apply 的路径，frontmatter 也写不进任意值）
    ...(EPISTEMIC_TYPES.has(decision.epistemic_type) ? [`epistemic_type: ${decision.epistemic_type}`] : []),
    // SEC-6（审计 B）：title 原只剥 `\n`，仍放行 `\r`/`\t` 等控制字符（可拆行/错位注入 frontmatter）。
    // 改剥【全部】控制字符（C0 \u0000-\u001f 含 \n\r\t + DEL \u007f）→ 强制 title 落在一行，注入行无从另起。
    `title: ${(decision.title ?? slug).replace(/[\u0000-\u001f\u007f]/g, ' ')}`,
    `created: ${today()}`,
    `updated: ${today()}`,
    // SEC-6（审计 B）：page_type 原样落进 `type:` 行、零清洗——注入的决定塞 page_type:"note\nowner_ruling: forged"
    // 即在 frontmatter 里另起伪造认证行。改为 slug 白名单（字母/数字/下划线/连字符）：非法/缺省回落 zone.id。
    `type: ${/^[\w-]+$/.test(String(decision.page_type ?? '')) ? decision.page_type : zone.id}`,
    `sources: [inbox ${entry.id} via ${entry.client}]`,
    '---',
    '',
  ].join('\n');
  // 相关页互链（LLM 提名、代码验真：不存在的页不硬凑）
  const validLinks = (Array.isArray(decision.links) ? decision.links : [])
    .filter((l) => typeof l === 'string' && /^[\w-]+$/.test(l))
    .filter((l) => findPageByStem(instanceDir, zone.path, l));
  const linksSection = validLinks.length ? `\n\n相关：${validLinks.map((l) => `[[${l}]]`).join('、')}\n` : '\n';
  writeFileSync(abs, fm + entry.body.trim() + linksSection);
  // 登记索引（reindex 会给新页入链，免成孤儿）
  const pageDir = path.posix.dirname(rel);
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
    ['reindex', '--instance', '.', '--dir', pageDir, '--apply']);
  return { changedPaths: [rel, `${pageDir}/README.md`], detail: rel };
}

function replaceSkill(instanceDir, entry, decision) {
  const rel = decision.target;
  const abs = path.join(instanceDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`目标页不存在：${rel}`);
  const oldId = readContentId(readFileSync(abs, 'utf8')) || newContentId();
  writeFileSync(abs, skillDocumentWithContentId(entry.body, oldId));
  return { changedPaths: [rel], detail: rel };
}

function mergeInto(instanceDir, entry, decision, zone) {
  const slug = decision.target.replace(/\.md$/, '');
  const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
  const abs = path.join(instanceDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`目标页不存在：${rel}`);
  let text = readFileSync(abs, 'utf8');
  // 分层不降级（spec §6.1）：目标页现档（无 tier 视同 canonical）与本次决定档取较高者——
  // 已 canonical 的页不因一次 candidate 合并被拉低；反向可晋升（canonical 内容并入 candidate 页 → 升 canonical）。
  const curTier = readTier(text);
  const decTier = normTier(decision.tier);
  const effTier = TIER_RANK[decTier] > TIER_RANK[curTier] ? decTier : curTier;
  text = text.replace(/^updated: .*$/m, `updated: ${today()}`);
  // 仅当档位非 canonical、或页上本就有显式 tier 行时才写——不给无 tier 的存量 canonical 页凭空加行（零回填即兼容）。
  if (effTier !== 'canonical' || hasExplicitTier(text)) text = setTierLine(text, effTier);
  // 溯源随归档注记行走，不上页级 frontmatter——一页可混多种认知类型，页头钉死单一 source/type 会说谎（spec §3.3）。
  const typeNote = decision.epistemic_type ? `，type: ${decision.epistemic_type}` : '';
  text += `\n\n---\n\n**${today()} keeper 归档**（inbox ${entry.id}，来自 ${entry.client}，confidence ${decision.confidence}${typeNote}）：\n\n${entry.body.trim()}\n`;
  writeFileSync(abs, text);
  return { changedPaths: [rel], detail: rel };
}

function findPageByStem(instanceDir, zonePath, stem) {
  const dir = path.join(instanceDir, zonePath);
  if (!existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name === `${stem}.md`) return true;
    }
  }
  return false;
}

function slugify(s) {
  const ascii = String(s).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `item-${Date.now().toString(36)}`;
}
