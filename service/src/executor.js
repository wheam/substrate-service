// keeper 的确定性执行器：LLM 只出决定，落盘永远走这里（直改文件或调实例 vendored 脚本）。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseZones } from './acl.js';
import { newContentId } from './content-id.js';
import { normTier, readTier, hasExplicitTier, setTierLine, TIER_RANK, DECISION_TIERS } from './tier.js';

const DISPOSITIONS = new Set(['canonical', 'reference', 'local-only', 'forbidden']);
// schema_apply（M4.4 D2b）：落地一个 zone 提案。内容只认提案件正文的 json 块，decision 只能「指向」件（白名单原则）。
// merge_pages（M4.4 D3）：夜班去重/薄页合并的确定性落点——现有 merge_into 并入的是 entry.body（收件正文），
// 对夜班提案件那是「提案文案」，执行它语义全错；真语义 = 源页正文并入目标页 + 删源页清反链，须一个原子动作表达。
const ACTIONS = new Set(['new_page', 'merge_into', 'upsert_row', 'todo_add', 'remove_page', 'todo_done', 'schema_apply', 'merge_pages']);
// 缺陷3：只有落成页文件的 action（new_page/merge_into）能把 tier 写进 frontmatter 持久化。
// upsert_row（.csv 行）/todo_add（清单行）/todo_done/remove_page 无 tier 粒度落点 → 见下方归一。
const TIER_BEARING_ACTIONS = new Set(['new_page', 'merge_into']);
// epistemic_type 白名单（spec §3.3）：这条内容「是什么性质的知识」。keeper 判时可选产出。
// 是描述性元数据、非门禁——白名单外/缺省一律归 null 放行，绝不因此拒件（假 provider/旧金标无此字段仍须过考卷）。
const EPISTEMIC_TYPES = new Set(['fact', 'preference', 'decision', 'opinion', 'excerpt', 'to-verify']);
// 骨架/流水区永久禁删（keeper 对 inbox 的清理走内部通路，不经 remove_page）
const NO_DELETE_ZONES = new Set(['governance', 'skills', 'inbox', 'keeper-feedback']);

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

// doctor 迁自 keeper（Global Constraints：共用一处）。行为不变：enabled=false → null；无 doctor.py（execFile 失败）
// → stdout 空 → 正则不命中 → null。null 语义 = 「无 doctor 视为无告警」，调用方按 0 处理（不阻断）。
export function runDoctor(instanceDir, { enabled = true } = {}) {
  if (!enabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('python3', [path.join(instanceDir, 'skills', 'substrate-doctor', 'doctor.py'), '.'],
      { cwd: instanceDir, timeout: 120_000, encoding: 'utf8' },
      (_err, stdout) => {
        const m = String(stdout).match(/→ (\d+) error/);
        resolve(m ? Number(m[1]) : null);
      });
  });
}

// 从提案件正文取首个 ```json 块并 parse（schema 内容只认件自身——白名单原则）。无块/非法 JSON → null。
function extractSchemaPayload(entry) {
  const src = entry?.raw ?? entry?.body ?? '';
  const m = String(src).match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
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
  return !target || typeof target !== 'string' || path.isAbsolute(target) || target.split('/').some((s) => s === '..' || s === '.git');
}

// slug → 实例内页相对路径（slug 可自带 zone 前缀也可不带，与 remove_page/merge_into 的既有惯例同义）
function pageRel(zone, slugRaw) {
  const slug = String(slugRaw).replace(/\.md$/, '');
  return slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
}

// 决定合法性校验（代码层，模型说什么不算数）
export function validateDecision({ instanceDir, decision, entry }) {
  const d = decision ?? {};
  if (!DISPOSITIONS.has(d.disposition)) return { ok: false, reason: `disposition 不合法：${d.disposition}` };
  if (d.disposition === 'forbidden') return { ok: true, verdict: 'reject', reason: d.reject_reason || '按宪法禁止入库' };
  if (d.disposition === 'local-only') return { ok: false, reason: 'local-only 在服务端无意义（无本地），需主人定夺' };
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
    if (entry?.kind !== 'remove' && !rulingMarked) {
      return { ok: false, reason: `remove_page 仅用于删除件（kind=remove）或主人明确裁定；本件 kind=${entry?.kind ?? '未知'} 且无认证的主人裁定，不予删除（需主人确认）` };
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
    case 'remove_page': return removePage(instanceDir, decision, zone);
    case 'merge_pages': return mergePages(instanceDir, decision, zone);
    case 'schema_apply': return applySchema({ instanceDir, entry }); // zone 参数忽略——schema 内容只从件正文取
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

  // doctor 校验（enabled:true——schema 落地的验收就是 doctor 0 error）。errors>0 显式回滚、不 commit、throw。
  const errors = await runDoctor(instanceDir, { enabled: true });
  if (errors && errors > 0) {
    await git(instanceDir, ['checkout', '--', zonesRel]); // 撤回 zones.md 追加（回到 HEAD，本 transact 前已 commit）
    // 只删「本次新建」：上方已存在即拒的守卫保证 dirAbs 必为本次 mkdirSync 所建，递归删不可能波及既有树。
    rmSync(dirAbs, { recursive: true, force: true });
    throw new Error(`doctor 报 ${errors} error，已回滚`);
  }
  return {
    changedPaths: [zonesRel, `${v.path}README.md`, `${v.path}.gitkeep`],
    detail: `zone ${v.id} 已建（${v.path}）`,
    zoneId: v.id,
  };
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
  const slug = decision.target.replace(/\.md$/, '');
  const rel = path.posix.join(zone.path, `${slug}.md`);
  const abs = path.join(instanceDir, rel);
  if (existsSync(abs)) throw new Error(`页已存在：${rel}（该用 merge_into）`);
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
    `title: ${(decision.title ?? slug).replace(/\n/g, ' ')}`,
    `created: ${today()}`,
    `updated: ${today()}`,
    `type: ${decision.page_type ?? zone.id}`,
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
  const zoneDir = zone.path.replace(/\/$/, '');
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
    ['reindex', '--instance', '.', '--dir', zoneDir, '--apply']);
  return { changedPaths: [rel, `${zoneDir}/README.md`], detail: rel };
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
