// 夜班 v0.6（M4.6 D1/D3）：纯确定性零 LLM 的维护扫描——挂在 keeper tick 里跑。
// M4.6 去人化改造（源于夜班首跑真机复盘，违反原则 B）：
//   - 薄页/近似重复页不再产出 remove_page/merge_pages 维护提案件，改为【进程内确定性 set_tier 降级
//     （canonical→candidate）】——可逆、零裁定、不经 inbox 文件往返（顺带消灭该路径的注入面：无提案文件可伪造）。
//   - 断链等只报告类产物落 governance/maintenance-log.md（D3），不进主人收件箱（只有人能判断的件才进）。
//   - 迁移（M4.6 加固）：只【关闭】库里遗留的 client:nightly/kind:maintenance 死件——绝不读件正文、不据件内容
//     改任何页（Finding1 blocker：旧 migrateLegacy 信件正文 JSON 调 setPageTier，成了 keeper 身份的「持续可逆
//     软删除任意页」通道，git-pull 伪造件即可触发，违背「伪造件应 inert」核心边界）。遗留薄页/重复页/断链的
//     处置交给下方新 scan 自然重扫（薄页会被重扫降级、断链会被重扫写维护日志），迁移只做行政性关件。
// 抗诱饵（M4.6 Finding2）：薄页/重复判定只在 canonical 页里做，重复对的保留侧按 created 更早者定（不用可被
//   诱饵页操纵的正文长度），有入链的页不自动降级（被依赖）——堵「更长的诱饵页反向挤降正典页」。
// 抗注入（M4.6 Finding3）：一切进 digest/维护日志的页路径过 displaySafePath 单行化+实体化（路径=git 文件名，可含
//   换行/Markdown/控制字符）。明确不做（v0 裁剪，理由入 docs §9）：孤儿检测、矛盾旗标、keeper 聚簇自动提 zone。
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseZones } from './acl.js';
import { setPageTier } from './executor.js';
import { readTier } from './tier.js';
import { caseLogSafe, displaySafePath } from './keeper.js';

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
          // tier（Finding2）：只在 canonical 页里找薄页/重复——已 candidate/rejected 页不该再参与、更不该当降级依据。
          // created（Finding2）：重复对的保留侧按它定（更早者留），比可被诱饵操纵的正文长度更难伪造；缺失/非法 → null。
          const tier = readTier(raw);
          const created = parseDate(fm.match(/^created:\s*(.+)$/m)?.[1]?.trim());
          pages.push({ rel, stem: name.replace(/\.md$/, ''), zone: z.id, tier, created, title, body, titleSet: titleTokens(title), bigramSet: bodyBigrams(body) });
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

  // 入链索引（Finding2）：stem → 引用它的内容页集合。只从【内容页】（listPages 的产物）取链——刻意【不】把
  // zone README 索引/`_` 结构页当来源：curate reindex 会给 zone 里每一页自动补一条 `| [[page]] |` 索引行，
  // 若把它算入链则库里每页都「被依赖」→ 薄页/重复降级永不触发。真正的「被依赖」= 别的内容页在正文里editorial 地
  // `[[..]]` 引用它（如「相关：[[x]]」）。先 stripCode 对齐断链检测：代码示例里的 [[..]] 不算真链。
  function backlinkIndex(pages) {
    const idx = new Map();
    for (const src of pages) {
      for (const m of stripCode(src.body).matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        const stem = m[1].split(/[|#]/)[0].trim().split('/').pop();
        if (!stem) continue;
        if (!idx.has(stem)) idx.set(stem, new Set());
        idx.get(stem).add(src.rel);
      }
    }
    return idx;
  }

  // 纯函数可测：确定性检出，不写任何文件。返回可自动降级的 duplicates/thin、只报告的 brokenLinks、
  // 以及【转建议不落盘】的 suggestions（created 无法判定保留侧、或有入链被依赖的疑似页——需人工确认）。
  function scan() {
    const pages = listPages();
    const backlinks = backlinkIndex(pages);
    // 有其它内容页链入 = 被依赖 → 不自动降级（入链保护）。自链不算（source !== 自身 rel）。
    const hasInlink = (p) => { const s = backlinks.get(p.stem); return !!s && [...s].some((r) => r !== p.rel); };
    // 只在 canonical 页里找薄页/重复：已 candidate/rejected 页不再参与、更不该当降级依据（Finding2 反诱饵核心）。
    const canonical = pages.filter((p) => p.tier === 'canonical');
    const duplicates = [];
    const thin = [];
    const brokenLinks = [];
    const suggestions = [];

    // 近似去重（同 zone 内两两比对，双方都 canonical）：保留侧 = created 更早者（诱饵页是新 push 进来的、created
    // 晚 → 落为被降级方；真页 created 早 → 保留）。tiebreak 【不用正文长度】——那正是诱饵的操纵杠杆（更长的诱饵
    // 反向挤降正典）。created 相同/缺失 → 无法判定保留侧 → 保守转建议、不自动降级。被降级方有入链 → 转建议。
    for (let i = 0; i < canonical.length; i++) {
      for (let j = i + 1; j < canonical.length; j++) {
        const p = canonical[i], q = canonical[j];
        if (p.zone !== q.zone) continue;
        const score = similarity(p, q);
        if (score < DUP_THRESHOLD) continue;
        const cmp = compareCreated(p.created, q.created);
        if (cmp === 0) { // created 无法比较（相同/任一缺失）→ 保守，不自动降级
          suggestions.push({ page: p.rel, peer: q.rel, reason: 'duplicate-tie', zone: p.zone });
          continue;
        }
        const [keep, demote] = cmp < 0 ? [p, q] : [q, p]; // cmp<0：p 更早 → 留 p、降 q
        if (hasInlink(demote)) { // 被降级方被别的页依赖 → 转建议、不自动降级
          suggestions.push({ page: demote.rel, peer: keep.rel, reason: 'duplicate-inlink', zone: p.zone });
          continue;
        }
        duplicates.push({ a: keep.rel, b: demote.rel, zone: p.zone, score: Math.round(score * 100) / 100 });
      }
    }

    // 薄页：canonical 页正文 <200 字符。有入链（被依赖）→ 转建议、不自动降级；否则降级。合并候选=同 zone 最相似的
    // canonical 页（≥0.3 才算沾边），没有就 null（M4.6 降级不用它，scan 仍算它供回归）。
    for (const p of canonical) {
      if (p.body.length >= THIN_CHARS) continue;
      if (hasInlink(p)) { suggestions.push({ page: p.rel, reason: 'thin-inlink', chars: p.body.length, zone: p.zone }); continue; }
      let best = null, bestScore = 0;
      for (const q of canonical) {
        if (q === p || q.zone !== p.zone) continue;
        const score = similarity(p, q);
        if (score > bestScore) { best = q; bestScore = score; }
      }
      thin.push({ page: p.rel, chars: p.body.length, mergeCandidate: bestScore >= CANDIDATE_THRESHOLD ? best.rel : null });
    }

    // 断链：[[stem]]（管道/锚点后缀剥掉、带路径取末段）在全库无 <stem>.md。v0 只报告不修
    // （executor 无文本编辑动作，自动改正文的风险大于收益）。先 stripCode 对齐 doctor：代码里的示例链不算断链。
    // 断链检出仍覆盖全部内容页（含 candidate——报告无副作用，不涉降级）；目标存在性面用全库 stem。
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

    return { duplicates, thin, brokenLinks, suggestions };
  }

  // 降级目标收集：近似重复对的冗余侧（b=被降级方）+ 薄页（自身）。去重（一页只降一次）；去重类优先、薄页其后
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
      // Finding3：page 与 stem 都过 displaySafePath 单行化+实体化——page 是 git 文件名（可含换行/Markdown/控制
      // 字符，非「服务端可控无括号」），stem 是页正文里的对抗输入；随后整行再过 caseLogSafe 把包裹 stem 的字面
      // `[[..]]` 也实体化（对 doctor 的任何 strip 免疫）。两遍幂等：displaySafePath 已把内容里的 [ ] 变实体，
      // caseLogSafe 只再中和我写的那对字面括号。
      const safePage = displaySafePath(b.page);
      const safeStem = displaySafePath(String(b.stem).slice(0, 100));
      const line = caseLogSafe(`- ${safePage} → [[${safeStem}]]（全库无对应页，v0 不自动改正文）`);
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
      // suggestions（Finding2）：created 无法判定保留侧 / 有入链被依赖的疑似页——未自动降级、转 digest 供人工确认（只带路径）。
      actions = {
        demoted,
        broken: [...new Set(found.brokenLinks.map((b) => b.page))], // 仅页路径
        suggestions: found.suggestions.map((s) => ({ page: s.page, reason: s.reason, ...(s.peer ? { peer: s.peer } : {}) })),
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

  // 迁移（M4.6 Finding1 加固）：只【关闭】库里遗留的 client:nightly/kind:maintenance 死件，绝不据件内容改任何页。
  // 为什么彻底放弃「根据件内容改页」：旧 migrateLegacy 直接信件正文 JSON 的 op/page/source 去调 setPageTier 降级
  // 引用的页——而 setPageTier 只拦骨架/结构/越界/不存在，不拦 sensitive/任意 zone。inbox 件活在 git 里、git pull
  // 是对抗输入：攻击者 push 一个 client:nightly/kind:maintenance 件、正文 `{"op":"remove_page","page":"memory/…"}`，
  // 每个 keeper tick 常驻跑的 migrateLegacy 就以 keeper 身份把该敏感页 canonical→candidate 软删除，全程无
  // resolveEntry/批准登记表。这把「本应 inert 的伪造维护件」升级成「持续可逆软删除任意内容页」的通道，直接违背
  // 「git-pulled 伪造件应 inert」的核心边界。故收窄为：筛选只按 client+kind（服务端行政筛选、零内容信任），命中即
  // 关闭（走确定性关闭通路、留审计痕迹），完全不读件正文、不调 setPageTier、不碰任何内容页。真遗留薄页/重复页的
  // 降级、断链的报告，全交给下方新 scan 自然重扫（它们本就是薄页/重复/断链，scan 会重新扫到并处置）。
  // 结果：即便攻击者 push 伪造 nightly/maintenance 件，migrateLegacy 顶多关掉攻击者自己的伪造件（零收益）。
  async function migrateLegacy() {
    if (!writer || !inbox) return { migrated: 0 };
    let legacy;
    try {
      // 只按行政字段筛（client + 归一后的 kind）——不解析、不信任件正文的任何字段。
      legacy = inbox.listEntries().entries.filter((e) => e.kind === 'maintenance' && e.client === 'nightly');
    } catch { return { migrated: 0 }; }
    if (!legacy.length) return { migrated: 0 };
    let migrated = 0;
    for (const e of legacy) {
      try {
        await closeEntry(e.path, e.id);
        migrated++;
      } catch (err) {
        console.error(`夜班关闭遗留件失败（跳过，下轮再试）：${e.id} ${err.message}`);
      }
    }
    if (migrated > 0) audit({ tool: 'nightly', event: 'migrate_run', migrated });
    return { migrated };
  }

  // 关闭一件遗留 maintenance 死件：rmSync + commit（现有确定性关闭通路，git 历史留审计痕迹）+ audit。
  // 只删这一个 inbox 件、不碰任何内容页；幂等（件关闭后再跑 listEntries 扫不到 → 零重复）。
  async function closeEntry(entryRel, entryId) {
    await writer.transact(async (commit) => {
      rmSync(path.join(instanceDir, entryRel));
      return commit({ paths: [entryRel], message: `nightly: 关闭遗留维护死件 ${entryId}（不碰内容页）` });
    });
    audit({ tool: 'nightly', event: 'migrate', entry: entryId, action: 'closed' });
  }

  return { scan, maybeRun, migrateLegacy, readState };
}

// digest「夜班上轮动作」段（spec §9 D1）：只含页路径、动作、原因分类、计数——绝不带页面正文摘录（正文=对抗
// 输入，与 nudge/held 摘要红线同款）。断链只给页路径 + 计数（stem 是对抗输入，不进 digest 面），详情指向维护日志。
// Finding3：所有页路径均过 displaySafePath——digest 是高信任 agent 的提示面，路径=git 文件名（可含换行/Markdown/
// 控制字符），裸拼即注入（伪造 heading/换行插指令/wikilink/<script>）。
export function formatNightlyDigest(state) {
  const a = state?.lastActions;
  if (!a || (!a.demoted?.length && !a.broken?.length && !a.suggestions?.length)) return '';
  const lines = ['', '---', '', '## 夜班上轮动作', ''];
  if (a.demoted?.length) {
    lines.push(`降级 ${a.demoted.length} 页（薄页/近似重复 → candidate；默认检索不含、git 仍可查；高信任 page_set_tier 可一句话恢复）：`);
    for (const d of a.demoted) {
      const why = d.reason === 'thin' ? `薄页${d.chars != null ? ` ${d.chars} 字符` : ''}` : d.reason === 'duplicate' ? '近似重复' : String(d.reason ?? '');
      lines.push(`- ${displaySafePath(d.page)}（${why}）`);
    }
  }
  if (a.broken?.length) {
    if (a.demoted?.length) lines.push('');
    lines.push(`报告断链 ${a.broken.length} 处（详见 governance/maintenance-log.md，无需裁定）：`);
    for (const p of a.broken) lines.push(`- ${displaySafePath(p)}`);
  }
  // 建议（Finding2）：疑似重复/薄页但因 created 无法判定保留侧、或有入链被依赖 → 未自动降级，仅供人工确认。
  if (a.suggestions?.length) {
    if (a.demoted?.length || a.broken?.length) lines.push('');
    lines.push(`另有 ${a.suggestions.length} 处疑似冗余/薄页未自动降级（需人工确认，可用 page_set_tier 处理）：`);
    for (const s of a.suggestions) {
      const why = s.reason === 'duplicate-tie' ? '疑似重复但创建时间无法判定保留侧'
        : s.reason === 'duplicate-inlink' ? '疑似冗余但有其它页链入（被依赖）'
        : s.reason === 'thin-inlink' ? '薄页但有其它页链入（被依赖）' : String(s.reason ?? '');
      lines.push(`- ${displaySafePath(s.page)}${s.peer ? `（疑似与 ${displaySafePath(s.peer)} 重复）` : ''}（${why}）`);
    }
  }
  return lines.join('\n');
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

// created 解析（Finding2 重复对保留侧判定用）：frontmatter 的 created 是 YYYY-MM-DD 形状；解析成毫秒时间戳，
// 非法/缺失 → null。用 Date.parse（对 YYYY-MM-DD 稳定），只接受能解析成有限数的值。
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? t : null;
}

// created 比较：返回 -1（a 更早，留 a）/ 1（b 更早，留 b）/ 0（相同或任一缺失 → 无法判定保留侧，保守不自动降级）。
// 威胁模型：诱饵页是新 push 进来的（created 晚）→ 落为被降级方；真页 created 早 → 保留。缺失/相同一律保守转建议。
function compareCreated(a, b) {
  if (a == null || b == null || a === b) return 0;
  return a < b ? -1 : 1;
}
