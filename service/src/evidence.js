// evidence.js —— recall 的「证据扩展」：把词法命中的行，扩成【可引用的章节原文】。
//
// 为什么要有这一层（知识库易用性首批）：recall 旧版只把每页最多 3 条 200 字的命中行喂给 LLM。
// 主人一页里写着「预算上限 / 硬规则 / 例外 / 新旧变更」的规则页，命中行只会带回其中一两条——
// 答案看起来有引用，实际漏掉后半段的硬约束与例外，而且没人知道漏了。本模块负责：
//   ① 按命中行定位【所在章节】，带合理邻接上下文，保留标题层级；短页直接给全文；
//   ② 明确的字符预算 + 页数上限，超了就【显式标截断】，绝不把 8 页当成全部；
//   ③ 展开前对每一页重新把关——路径、ACL、tier、文件身份（content_id）——
//      任何一项不过就整页丢弃，绝不退回索引里那份可能已经过期/越权的旧片段。
//
// 安全立场：库文件是【对抗输入】。这里只读文本、只切片、只计数，不解释文件里的任何命令口吻内容；
// 路径一律在实例目录内做 realpath 收敛（软链指向实例外、或中途经过软链的页，一律拒绝展开）。
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseZones, canReadZone, zoneFor, SERVICE_ZONE_IDS } from './acl.js';
import { readTier } from './tier.js';
import { readContentId } from './content-id.js';

// 首批实验起始预算（不是性能承诺，见 docs/08-knowledge-usability.md）：
export const EVIDENCE_BUDGET_CHARS = 12000; // 一次 recall 全部证据的字符总预算
export const PAGE_FULL_CHARS = 2000;        // 正文不超过这个长度的页 → 直接给全文
export const PAGE_MAX_CHARS = 4000;         // 单页证据上限（防一页吃光整个预算）
export const ADJACENT_LINES = 6;            // 命中章节前后各带几行邻接上下文
export const MIN_BLOCK_CHARS = 300;         // 预算余量低于此值就不再塞半截证据，直接记为未纳入
const MIN_PARTIAL_CHARS = 80;               // 单块至少要留这么多字才值得给半截

const SEARCHABLE_MD = '.md';

// 丢弃原因（返回给上层做诚实的 gaps/truncated 文案；不含任何页内容）。
export const DROP_REASONS = {
  path: '路径不可信（越界或经过符号链接）',
  zone: '不在可读知识分区内',
  acl: '当前信任级不可读该分区',
  tier: '该页已不是正典（tier 变更）',
  identity: '文件身份与索引不一致（content_id 已变）',
  unreadable: '当前读取失败',
  budget: '证据预算已用尽，未纳入',
};

// 把候选路径收敛到实例目录内的真实文件。分两步，顺序是刻意的：
// ① 语法层（相对路径、无 ..、非 .git）——先于 zone/ACL 判定，越界路径根本不该走到「它属于哪个分区」这一步；
// ② realpath 收敛：解析后必须仍在实例内，且【逐字等于逻辑路径】——中途经过软链的页一律拒，
//    否则 knowledge/x.md → memory/… 的软链能绕开按逻辑路径做的 ACL，指向实例外则直接外泄。
function assertSyntacticPath(instanceDir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error('非法路径');
  const abs = path.resolve(instanceDir, rel);
  const within = path.relative(instanceDir, abs);
  if (!within || within.startsWith('..') || within.split(path.sep)[0] === '.git') throw new Error('越界路径');
  return abs;
}

function resolveTrustedPage(instanceDir, rel, abs) {
  const realInst = realpathSync(instanceDir);
  const realAbs = realpathSync(abs); // 文件不存在会抛 → 上层记 path
  const realRel = path.relative(realInst, realAbs).split(path.sep).join('/');
  if (realRel !== rel) throw new Error('路径经过符号链接或越界');
  if (!statSync(realAbs).isFile()) throw new Error('不是普通文件');
  return realAbs;
}

// 把一页切成章节：ATX 标题（# ~ ######）为界，记录标题层级路径与 1-based 起止行号。
// frontmatter 不进正文证据（是元数据，不是规则），但行号始终按【文件真实行号】算，
// 这样引用里的行范围能被主人/外层 agent 拿去核对。
export function parseSections(text) {
  const lines = String(text).split('\n');
  let bodyStart = 1;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) bodyStart = close + 2;
  }
  const sections = [];
  const stack = [];
  let fence = null;
  let cur = { heading: null, headingPath: [], start: bodyStart, end: lines.length };
  for (let i = bodyStart - 1; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
    const m = lines[i].match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (!m) continue;
    cur.end = i; // 上一节止于本标题的前一行（1-based 行号 = i）
    if (cur.end >= cur.start) sections.push(cur);
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const title = m[2].trim();
    cur = { heading: title, headingPath: [...stack.map((x) => x.title), title], start: i + 1, end: lines.length };
    stack.push({ level, title });
  }
  if (cur.end >= cur.start) sections.push(cur);
  return { lines, bodyStart, sections };
}

// 单页证据：短页整页；长页按【命中所在章节 + 邻接上下文】切块，块间不重叠、各自带标题层级。
function pageBlocks({ lines, bodyStart, sections }, hitLines, pageBudget) {
  const bodyChars = lines.slice(bodyStart - 1).join('\n').trim().length;
  const lastLine = lines.length;
  let ranges;
  // 标题/元数据命中只定位到页面，不能把标题附近几行当成页面的全部规则。
  const proseHits = hitLines.filter((n) => n >= bodyStart && lines[n - 1]?.trim()
    && !sections.some((s) => s.heading !== null && s.start === n));
  if (bodyChars <= PAGE_FULL_CHARS || !proseHits.length) {
    ranges = [{ heading: sections[0]?.heading ?? null, headingPath: sections[0]?.headingPath ?? [], start: bodyStart, end: lastLine, full: true }];
  } else {
    const hits = new Set(hitLines.filter((n) => n >= bodyStart));
    let selected = sections.filter((s) => [...hits].some((n) => n >= s.start && n <= s.end));
    // 只在 frontmatter 命中（如标题匹配）→ 没有正文章节可选：退而给页首一段，仍走同样的预算与截断口径。
    if (!selected.length) selected = sections.slice(0, 1);
    ranges = [];
    let prevEnd = bodyStart - 1;
    for (let i = 0; i < selected.length; i++) {
      const sec = selected[i];
      const nextStart = selected[i + 1]?.start ?? lastLine + 1;
      const start = Math.max(prevEnd + 1, bodyStart, sec.start - ADJACENT_LINES);
      const end = Math.min(nextStart - 1, lastLine, sec.end + ADJACENT_LINES);
      if (end < start) continue;
      ranges.push({ heading: sec.heading, headingPath: sec.headingPath, start, end, full: false });
      prevEnd = end;
    }
  }

  const blocks = [];
  let used = 0;
  let truncated = false;
  const covered = [];
  for (const r of ranges) {
    const remaining = pageBudget - used;
    if (remaining < MIN_PARTIAL_CHARS) { truncated = true; break; }
    // 按顺序累计一次，避免大章节逐行回退 + 反复 join 的平方级成本。
    let end = r.start - 1;
    let chars = 0;
    let partialLine = false;
    const picked = [];
    for (let n = r.start; n <= r.end; n++) {
      const line = lines[n - 1];
      const cost = line.length + (picked.length ? 1 : 0);
      if (chars + cost > remaining) {
        if (!picked.length) { picked.push(line.slice(0, remaining)); end = n; partialLine = true; }
        truncated = true;
        break;
      }
      picked.push(line); chars += cost; end = n;
    }
    const text = picked.join('\n').trim();
    if (!text) continue;
    blocks.push({
      heading: r.headingPath?.length ? r.headingPath.join(' > ') : (r.heading ?? null),
      lines: `${r.start}-${end}`,
      text,
      full_page: !!r.full && end === r.end && !partialLine,
      ...(partialLine ? { partial_line: true } : {}),
    });
    covered.push({ start: r.start, end });
    used += text.length;
    if (end < r.end) { truncated = true; break; }
  }
  // 章节选择本身也可能遗漏内容；即使未耗尽预算，也必须让宿主知道尚非整页。
  let range = 0;
  for (let n = bodyStart; n <= lastLine; n++) {
    while (range < covered.length && covered[range].end < n) range++;
    if (lines[n - 1].trim() && (!covered[range] || n < covered[range].start)) { truncated = true; break; }
  }
  return { blocks, used, truncated };
}

/**
 * 把候选页展开成证据块。
 * candidates: [{ path, content_id, zone?, lines?: number[] }]（lines = index 给出的命中行号）
 * 返回 { pages, dropped, used, budget, truncated }；pages 是【经过重新把关后】可引用的全部页。
 */
export function collectEvidence({
  instanceDir, candidates = [], trust = 'low',
  budget = EVIDENCE_BUDGET_CHARS, zones = null,
} = {}) {
  const zs = zones ?? parseZones(instanceDir);
  const pages = [];
  const dropped = [];
  let used = 0;
  let truncated = false;

  for (const cand of candidates) {
    const rel = cand?.path;
    // ① 路径语法：越界/绝对路径/.git 先拒——不给它机会参与后面的分区判定或触碰磁盘。
    let abs;
    try { abs = assertSyntacticPath(instanceDir, rel); }
    catch { dropped.push({ path: rel, reason: 'path' }); continue; }

    // ② zone / ACL：按【逻辑路径】判，与 search/index 同口径。
    const zone = zoneFor(zs, rel);
    if (!zone || SERVICE_ZONE_IDS.has(zone.id)) { dropped.push({ path: rel, reason: 'zone' }); continue; }
    if (!canReadZone(zone, trust)) { dropped.push({ path: rel, reason: 'acl' }); continue; }
    if (rel.startsWith('skills/_incoming/')) { dropped.push({ path: rel, reason: 'tier' }); continue; }

    // 预算耗尽也先检查可见范围，不能通过 incomplete 路径泄漏不可读候选。
    if (budget - used < MIN_BLOCK_CHARS) {
      dropped.push({ path: rel, reason: 'budget' });
      truncated = true;
      continue;
    }

    // ③ realpath 收敛（软链/越界）+ 读盘
    try { abs = resolveTrustedPage(instanceDir, rel, abs); }
    catch { dropped.push({ path: rel, reason: 'path' }); continue; }
    let text;
    try { text = readFileSync(abs, 'utf8'); }
    catch { dropped.push({ path: rel, reason: 'unreadable' }); continue; }

    // ④ 正典与文件身份复核：索引可能已过期，任何不一致都整页丢弃（不退回旧片段）。
    const isMd = path.extname(rel) === SEARCHABLE_MD;
    if (isMd && readTier(text) !== 'canonical') { dropped.push({ path: rel, reason: 'tier' }); continue; }
    const diskCid = isMd ? readContentId(text) : null;
    if (cand.content_id && diskCid !== cand.content_id) { dropped.push({ path: rel, reason: 'identity' }); continue; }

    const parsed = parseSections(text);
    const hitLines = Array.isArray(cand.lines) ? [...new Set(cand.lines)].sort((a, b) => a - b) : [];
    const pageBudget = Math.min(PAGE_MAX_CHARS, budget - used);
    const { blocks, used: pageUsed, truncated: pageTruncated } = pageBlocks(parsed, hitLines, pageBudget);
    if (!blocks.length) { dropped.push({ path: rel, reason: 'budget' }); truncated = true; continue; }
    used += pageUsed;
    if (pageTruncated) truncated = true;
    pages.push({
      path: rel,
      content_id: diskCid ?? cand.content_id ?? null,
      zone: zone.id,
      blocks,
      truncated: pageTruncated,
    });
  }

  return { pages, dropped, used, budget, truncated: truncated || dropped.some((d) => d.reason === 'budget') };
}
