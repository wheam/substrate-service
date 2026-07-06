// 夜班 v0.6（M4.6 D1/D3）：纯确定性零 LLM 的维护扫描——挂在 keeper tick 里跑。
// M4.6 去人化改造（源于夜班首跑真机复盘，违反原则 B）：
//   - 薄页/近似重复页不再产出 remove_page/merge_pages 维护提案件，改为【进程内确定性 set_tier 降级
//     （canonical→candidate）】——可逆、零裁定、不经 inbox 文件往返（顺带消灭该路径的注入面：无提案文件可伪造）。
//   - 断链等只报告类产物落 governance/maintenance-log.md（D3），不进主人收件箱（只有人能判断的件才进）。
//   - 迁移：收编真机遗留的夜班来源 maintenance 件（弹回的删页提案 → 降级；断链报告 → 转维护日志），幂等清零。
// 明确不做（v0 裁剪，理由入 docs §9）：孤儿检测、矛盾旗标、keeper 聚簇自动提 zone。
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseZones } from './acl.js';
import { setPageTier } from './executor.js';
import { readTier } from './tier.js';
import { caseLogSafe } from './keeper.js';

// 骨架/流水区不进扫描：inbox 件与判例是流水、governance/skills 是骨架——它们不是「维护对象」，
// 且 inbox 正文是对抗输入，绝不该被相似度算法搬运进提案面。
const SKELETON_DIRS = new Set(['inbox', 'keeper-feedback', 'governance', 'skills']);
const DUP_THRESHOLD = 0.6;      // 近似去重：标题词集 Jaccard 与正文前 500 字符 bigram Jaccard 取大者
const THIN_CHARS = 200;         // 薄页：去 frontmatter 的正文严格小于此值
const CANDIDATE_THRESHOLD = 0.3; // 薄页合并候选的最低相似度（scan 仍算 mergeCandidate 供回归；M4.6 降级不再用它）
const MAX_DEMOTE = 5;           // 每轮降级上限：夜班是低频维护者，一晚最多降 5 页（沿旧 ≤5 提案上限）

// 标题分词：CJK 逐字 + 拉丁/数字连串——中文标题按词集 Jaccard 时整串比对几乎全有或全无，逐字才有区分度
function titleTokens(title) {
  return new Set(String(title).toLowerCase().match(/[\p{Script=Han}]|[a-z0-9]+/gu) ?? []);
}

// 正文前 500 字符的字符 bigram 集（空白折叠成单空格，排版差异不算内容差异）
function bodyBigrams(body) {
  const s = String(body).slice(0, 500).replace(/\s+/g, ' ');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function similarity(p, q) {
  return Math.max(jaccard(p.titleSet, q.titleSet), jaccard(p.bigramSet, q.bigramSet));
}

// 缩进代码块剥离——faithful port 自 doctor.py strip_indented_code：≥4 空格/tab 缩进、且前有空行（或文首）
// 的连续行块（块内可夹空行）。保守：只剥前有空行的缩进块，避免吞掉真实链接（宁漏剥不误吞）。
function stripIndentedCode(t) {
  const lines = String(t).split('\n');
  const out = [];
  const ind = (s) => s.startsWith('    ') || s.startsWith('\t');
  let prevBlank = true, i = 0;
  const n = lines.length;
  while (i < n) {
    if (prevBlank && ind(lines[i]) && lines[i].trim()) {
      while (i < n && ((ind(lines[i]) && lines[i].trim())
                    || (lines[i].trim() === '' && i + 1 < n && ind(lines[i + 1]) && lines[i + 1].trim()))) i++;
      prevBlank = false;
      continue;
    }
    out.push(lines[i]);
    prevBlank = lines[i].trim() === '';
    i++;
  }
  return out.join('\n');
}

// 断链检测前剥代码，与 doctor.py strip_code 同款同序（```围栏``` → ~~~ → 缩进码块 → 行内`码`）：文档页里
// `[[wikilink]]` 这类语法示例 doctor 不当实链，夜班也不该误判成断链去打扰主人。残余不一致再由 keeper 侧
// caseLogSafe 兜底（归档零方括号，doctor 恒不误红）。
function stripCode(s) {
  return stripIndentedCode(
    String(s)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, ''),
  ).replace(/`[^`]*`/g, '');
}

export function createNightly({
  instanceDir, inbox, notifier, audit = () => {},
  writer = null,        // M4.6：降级/维护日志/迁移的写入都走 writer.transact（沿夜班现有落盘方式，写与 commit 同队列串行）
  indexStore = null,    // 降级翻 tier 后刷新派生索引（candidate 默认检索不含）；缺省 null → 无副作用（老调用方/测试不变）
  intervalMs = 604_800_000, // 默认 7 天；0=禁用
  // 状态文件在实例 git 之外（与 recall-index 同级惯例）：lastRun/lastActions 是运维状态，不是知识，不进库
  statePath = path.resolve(instanceDir, '..', 'nightly-state.json'),
} = {}) {
  // 扫描对象：zones.md 注册、路径不落骨架区、且非 privacy:sensitive 的 zone 下全部 .md（递归），
  // 排除 README 与 _ 前缀结构/流水页。sensitive 区（如 memory）整体不进夜班：提案件正文会带页的
  // rel 路径/字符数等元数据，而它落 inbox 后除 inbox_list/nudge 外还经 GET /capture/status 对
  // capture-trust token 全量下发（server.js 的 mineOnly 只挡低信任档）——系统其余读路径全把
  // sensitive 锁 high-only（acl.js canReadZone、/mcp 403、digest high-only），提案面若含 memory/
  // 路径即越界泄漏。宁可敏感区的薄页/重复页由主人自己打理，夜班一页不碰。
  function listPages() {
    const zones = parseZones(instanceDir).filter((z) => z.path && !SKELETON_DIRS.has(z.path.split('/')[0]) && z.privacy !== 'sensitive');
    const pages = [];
    for (const z of zones) {
      const root = path.join(instanceDir, z.path);
      if (!existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        for (const name of readdirSync(d)) {
          const p = path.join(d, name);
          if (statSync(p).isDirectory()) { stack.push(p); continue; }
          if (!name.endsWith('.md') || name === 'README.md' || name.startsWith('_')) continue;
          const raw = readFileSync(p, 'utf8');
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
          const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() || name.replace(/\.md$/, '');
          const rel = path.relative(instanceDir, p).split(path.sep).join('/');
          pages.push({ rel, zone: z.id, title, body, titleSet: titleTokens(title), bigramSet: bodyBigrams(body) });
        }
      }
    }
    pages.sort((a, b) => a.rel.localeCompare(b.rel)); // 确定性输出顺序
    return pages;
  }

  // 全库 .md stem 集（断链判定面）：链接目标可能在任何目录，故不按 zone 裁剪，只排除 .git
  function allStems() {
    const stems = new Set();
    const stack = [instanceDir];
    while (stack.length) {
      const d = stack.pop();
      for (const name of readdirSync(d)) {
        if (name === '.git') continue;
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) stack.push(p);
        else if (name.endsWith('.md')) stems.add(name.replace(/\.md$/, ''));
      }
    }
    return stems;
  }

  // 纯函数可测：三类确定性检出，不写任何文件
  function scan() {
    const pages = listPages();
    const duplicates = [];
    const thin = [];
    const brokenLinks = [];

    // 近似去重（同 zone 内两两比对）：a=保留侧（正文较长者，等长取 rel 字典序小者），b=并入侧
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const p = pages[i], q = pages[j];
        if (p.zone !== q.zone) continue;
        const score = similarity(p, q);
        if (score < DUP_THRESHOLD) continue;
        const [keep, merge] = q.body.length > p.body.length ? [q, p] : [p, q];
        duplicates.push({ a: keep.rel, b: merge.rel, zone: p.zone, score: Math.round(score * 100) / 100 });
      }
    }

    // 薄页：正文 <200 字符；合并候选=同 zone 最相似页（≥0.3 才算沾边），没有就 null（→ remove 提案）
    for (const p of pages) {
      if (p.body.length >= THIN_CHARS) continue;
      let best = null, bestScore = 0;
      for (const q of pages) {
        if (q === p || q.zone !== p.zone) continue;
        const score = similarity(p, q);
        if (score > bestScore) { best = q; bestScore = score; }
      }
      thin.push({ page: p.rel, chars: p.body.length, mergeCandidate: bestScore >= CANDIDATE_THRESHOLD ? best.rel : null });
    }

    // 断链：[[stem]]（管道/锚点后缀剥掉、带路径取末段）在全库无 <stem>.md。v0 只报告不修
    // （executor 无文本编辑动作，自动改正文的风险大于收益）。先 stripCode 对齐 doctor：代码里的示例链不算断链。
    const stems = allStems();
    for (const p of pages) {
      const seen = new Set();
      for (const m of stripCode(p.body).matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        const stem = m[1].split(/[|#]/)[0].trim().split('/').pop();
        if (!stem || stems.has(stem) || seen.has(stem)) continue;
        seen.add(stem);
        brokenLinks.push({ page: p.rel, stem });
      }
    }

    return { duplicates, thin, brokenLinks };
  }

  // 降级目标收集：近似重复对的冗余侧（b=较短者）+ 薄页（自身）。去重（一页只降一次）；去重类优先、薄页其后
  // （沿旧 MAX 上限「去重优先」意图）。mergeCandidate 不再用于降级——M4.6 不再合并、只降级；scan 仍算它供 Group 2 回归。
  function collectDemoteTargets({ duplicates, thin }) {
    const seen = new Set();
    const out = [];
    for (const d of duplicates) if (!seen.has(d.b)) { seen.add(d.b); out.push({ page: d.b, reason: 'duplicate', chars: null }); }
    for (const t of thin) if (!seen.has(t.page)) { seen.add(t.page); out.push({ page: t.page, reason: 'thin', chars: t.chars }); }
    return out;
  }

  // 单页降级：进程内 setPageTier（canonical→candidate）+ writer.transact 提交（写与 commit 同队列串行）。
  // 每笔 audit（tool:'nightly', event:'demote', 带 page/reason/字符数/from-to）+ 索引刷新（candidate 默认检索不含）。
  async function demote(page, reason, chars) {
    let res;
    await writer.transact(async (commit) => {
      res = setPageTier({ instanceDir, page, tier: 'candidate' });
      if (!res.ok) throw new Error(res.reason);
      return commit({ paths: res.changedPaths, message: `nightly: demote ${res.page} → candidate（${reason}）` });
    });
    if (indexStore) { try { indexStore.updatePage(res.page); } catch (e) { console.error(`降级后索引刷新失败（不影响降级）：${e.message}`); } }
    audit({ tool: 'nightly', event: 'demote', page: res.page, reason, ...(chars != null ? { chars } : {}), from: res.from, to: res.to });
    return res;
  }

  // 断链等只报告类产物 → governance/maintenance-log.md（D3）：不进主人收件箱（只有人能判断的件才进）。
  // 追加行做与 keeper.caseLogSafe 同款方括号实体化——断链 stem 来自页正文（对抗输入），裸 [[..]] 落进日志会被
  // doctor 判实链→断链（曾致 CI 误红）；实体化后文本里根本不留 [ ]，对任何 strip 行为免疫。stem 再截断防灌长。
  // 去重：同 (page,stem) 已在日志里就不重复追加（跨轮/迁移幂等，不让未修的断链每 7 天刷一屏）。返回本次真写入的行。
  async function reportBrokenLinks(brokenLinks) {
    if (!writer || !brokenLinks.length) return [];
    const logRel = 'governance/maintenance-log.md';
    const logAbs = path.join(instanceDir, logRel);
    const d = today();
    let raw = existsSync(logAbs) ? readFileSync(logAbs, 'utf8') : maintenanceLogTemplate(d);
    const fresh = [];
    for (const b of brokenLinks) {
      // page 是 listPages 产出的实例内 rel（服务端可控、无括号）；stem 是对抗输入 → 截断 + 整行实体化。
      const line = caseLogSafe(`- ${b.page} → [[${String(b.stem).slice(0, 100)}]]（全库无对应页，v0 不自动改正文）`);
      if (raw.includes(line)) continue;
      fresh.push(line);
    }
    if (!fresh.length) return [];
    raw = raw.replace(/^updated: .*$/m, `updated: ${d}`);
    raw += `\n### ${d} 夜班断链报告\n\n${fresh.join('\n')}\n`;
    await writer.transact(async (commit) => {
      writeFileSync(logAbs, raw);
      return commit({ paths: [logRel], message: 'nightly: 断链报告落维护日志（不进收件箱）' });
    });
    return fresh;
  }

  function readState() {
    try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; }
  }
  function writeState(obj) {
    try { writeFileSync(statePath, JSON.stringify(obj)); }
    catch (e) { console.error(`夜班状态文件写入失败：${e.message}`); }
  }

  // 到期才跑：扫描 → 薄页/重复页进程内确定性 set_tier 降级（≤MAX_DEMOTE）→ 断链落维护日志 → 通知+审计。
  // 任何一步抛错都吞掉记日志，且 statePath 无论成败都推进——否则一处持续报错会让每个 keeper tick 重扫全库（错误风暴）。
  async function maybeRun() {
    if (!(Number(intervalMs) > 0)) return { ran: false, reason: 'disabled' };
    const last = readState().lastRun;
    // lastRun 非法（损坏的状态文件）→ Date.parse 得 NaN → 比较不成立 → 视为到期重跑（自愈）
    if (last && Date.now() - Date.parse(last) < Number(intervalMs)) return { ran: false, reason: 'not-due' };
    const t0 = Date.now();
    const out = { ran: true, duplicates: 0, thin: 0, broken: 0, demoted: 0, brokenReported: 0 };
    let actions = null;
    try {
      const found = scan();
      out.duplicates = found.duplicates.length;
      out.thin = found.thin.length;
      out.broken = found.brokenLinks.length;
      const demoted = [];
      // D1：薄页/重复页 → 进程内确定性 set_tier 降级，不写 inbox 提案、不需裁定。每轮 ≤MAX_DEMOTE；
      // 同页已 candidate 则跳过（幂等，不占额度、不误报审计）；sensitive 区 listPages 已整体排除。
      for (const tgt of collectDemoteTargets(found)) {
        if (out.demoted >= MAX_DEMOTE) break;
        const abs = path.join(instanceDir, tgt.page);
        if (!existsSync(abs)) continue;
        if (readTier(readFileSync(abs, 'utf8')) === 'candidate') continue; // 已降级 → 跳过
        await demote(tgt.page, tgt.reason, tgt.chars);
        demoted.push({ page: tgt.page, reason: tgt.reason, ...(tgt.chars != null ? { chars: tgt.chars } : {}) });
        out.demoted++;
      }
      // D3：断链只报告，落维护日志（不进主人收件箱）
      const reported = await reportBrokenLinks(found.brokenLinks);
      out.brokenReported = reported.length;
      // digest「夜班上轮动作」摘要：只留页路径 + 动作 + 原因分类 + 计数，绝不带页面正文摘录（stem 是对抗输入，不入）。
      actions = {
        demoted,
        broken: [...new Set(found.brokenLinks.map((b) => b.page))], // 仅页路径（服务端可控）
        counts: { demoted: out.demoted, broken: out.brokenReported },
      };
      // 零动作不打扰主人——audit 的 nightly_run 已是心跳，通知只在真有事时发
      if (out.demoted > 0 || out.brokenReported > 0) {
        await notifier.notify(`🌙 夜班降级了 ${out.demoted} 页（薄页/重复 → candidate，可逆、默认检索不含；高信任 page_set_tier 可一句话恢复）${out.brokenReported ? `，另报告 ${out.brokenReported} 处断链（已落维护日志，无需处理）` : ''}。`);
      }
      audit({ tool: 'nightly', event: 'nightly_run', duplicates: out.duplicates, thin: out.thin, broken: out.broken, demoted: out.demoted, brokenReported: out.brokenReported, ms: Date.now() - t0 });
    } catch (e) {
      out.error = e.message;
      console.error(`夜班本轮失败（状态仍推进，下轮到期再试）：${e.message}`);
    } finally {
      writeState({ lastRun: new Date().toISOString(), ...(actions ? { lastActions: actions } : {}) });
    }
    return out;
  }

  // 迁移（M4.6）：收编真机遗留的夜班来源 maintenance 件（M4.5 及以前夜班产的提案，含被通道限权弹回 re-held 的）。
  //   - 「薄页删除提案」(op:remove_page) / 合并提案(op:merge_pages) → 对涉及页执行 set_tier 降级（改删/合并为可逆降级）后关闭件；
  //   - 「断链报告」(type:broken-link) → 转写 maintenance-log 后关闭件。
  // 关闭 = rmSync 件 + commit（现有确定性通路），audited。幂等：件关闭后再跑扫不到（且降级已 candidate 会跳过）→ 零重复。
  // 只认 client:nightly & kind:maintenance（schema 提案 kind:schema 不动；新夜班不再产 maintenance，故清完永远 no-op）。
  async function migrateLegacy() {
    if (!writer || !inbox) return { migrated: 0 };
    let legacy;
    try {
      legacy = inbox.listEntries().entries.filter((e) => e.kind === 'maintenance' && e.client === 'nightly');
    } catch { return { migrated: 0 }; }
    if (!legacy.length) return { migrated: 0 };
    let migrated = 0;
    for (const e of legacy) {
      try {
        const raw = readFileSync(path.join(instanceDir, e.path), 'utf8');
        const block = firstJsonBlock(raw);
        if (block && block.op === 'remove_page' && block.page) {
          await migrateDemote(block.page, e.path, e.id, 'thin');
        } else if (block && block.op === 'merge_pages' && block.source) {
          await migrateDemote(block.source, e.path, e.id, 'duplicate');
        } else {
          // 断链报告或其它报告型：能取到 page 就转写维护日志，然后关闭件（无 op 的件不做任何页面改动）
          if (block && block.type === 'broken-link' && block.page) {
            await reportBrokenLinks([{ page: block.page, stem: block.stem ?? '' }]);
          }
          await closeEntry(e.path, e.id, 'report-migrated');
        }
        migrated++;
      } catch (err) {
        console.error(`夜班迁移单件失败（跳过，下轮再试）：${e.id} ${err.message}`);
      }
    }
    if (migrated > 0) audit({ tool: 'nightly', event: 'migrate_run', migrated });
    return { migrated };
  }

  // 遗留删/合并提案 → 改为可逆降级 + 关闭件（一个 transact 原子：页降级 + 件移除同提交）。页已 candidate/不存在则只关件。
  async function migrateDemote(page, entryRel, entryId, reason) {
    let res = null;
    await writer.transact(async (commit) => {
      const paths = [];
      const abs = path.join(instanceDir, String(page).endsWith('.md') ? page : `${page}.md`);
      if (existsSync(abs) && readTier(readFileSync(abs, 'utf8')) !== 'candidate') {
        res = setPageTier({ instanceDir, page, tier: 'candidate' });
        if (res.ok) paths.push(...res.changedPaths);
      }
      rmSync(path.join(instanceDir, entryRel));
      paths.push(entryRel);
      return commit({ paths, message: `nightly: 迁移收编遗留提案 ${entryId}（降级替代删除）` });
    });
    if (res?.ok && indexStore) { try { indexStore.updatePage(res.page); } catch { /* 索引刷新失败不影响迁移 */ } }
    audit({ tool: 'nightly', event: 'migrate', entry: entryId, action: 'demote', page, reason, ...(res?.ok ? { from: res.from, to: res.to } : { note: 'already-candidate-or-missing' }) });
  }

  async function closeEntry(entryRel, entryId, note) {
    await writer.transact(async (commit) => {
      rmSync(path.join(instanceDir, entryRel));
      return commit({ paths: [entryRel], message: `nightly: 迁移收编遗留报告 ${entryId}（转维护日志后关闭）` });
    });
    audit({ tool: 'nightly', event: 'migrate', entry: entryId, action: note });
  }

  return { scan, maybeRun, migrateLegacy, readState };
}

// digest「夜班上轮动作」段（spec §9 D1）：只含页路径、动作、原因分类、计数——绝不带页面正文摘录（正文=对抗
// 输入，与 nudge/held 摘要红线同款）。断链只给页路径 + 计数（stem 是对抗输入，不进 digest 面），详情指向维护日志。
export function formatNightlyDigest(state) {
  const a = state?.lastActions;
  if (!a || (!a.demoted?.length && !(a.broken?.length))) return '';
  const lines = ['', '---', '', '## 夜班上轮动作', ''];
  if (a.demoted?.length) {
    lines.push(`降级 ${a.demoted.length} 页（薄页/近似重复 → candidate；默认检索不含、git 仍可查；高信任 page_set_tier 可一句话恢复）：`);
    for (const d of a.demoted) {
      const why = d.reason === 'thin' ? `薄页${d.chars != null ? ` ${d.chars} 字符` : ''}` : d.reason === 'duplicate' ? '近似重复' : String(d.reason ?? '');
      lines.push(`- ${d.page}（${why}）`);
    }
  }
  if (a.broken?.length) {
    if (a.demoted?.length) lines.push('');
    lines.push(`报告断链 ${a.broken.length} 处（详见 governance/maintenance-log.md，无需裁定）：`);
    for (const p of a.broken) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

// 取提案件正文首个 ```json 块（迁移解析遗留件的 op/page/source/type）。无块/非法 JSON → null。
function firstJsonBlock(raw) {
  const m = String(raw ?? '').match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 维护日志页 frontmatter 备齐实例契约必填键（title/created/updated/type），确保真 doctor 0 error。
// governance/ 是骨架区、不进 listPages 扫描——本页不会被夜班反过来当薄页/断链源，无反馈回路。
function maintenanceLogTemplate(d) {
  return [
    '---', 'title: 夜班维护日志', 'type: log', `created: ${d}`, `updated: ${d}`, '---', '',
    '# 夜班维护日志', '',
    '夜班扫描出的只报告类产物（断链等，无需裁定）记录于此。看过即可，不需要操作。', '',
  ].join('\n');
}

// 日期串（YYYY-MM-DD）——降级/维护日志共用
function today() {
  return new Date().toISOString().slice(0, 10);
}
