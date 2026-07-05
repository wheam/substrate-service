#!/usr/bin/env node
// metrics.js — 从审计日志（AUDIT_FILE 的 JSON lines）算并打印两条使用曲线。
// 零第三方依赖；对空日志 / 缺字段的旧条目宽容（跳过而非崩溃）。
//
// 数据源：审计一行一 JSON（audit.js 写进 AUDIT_FILE 的就是纯 JSON 行；
// 若喂进来的是 stdout 日志则每行前缀 "AUDIT "，脚本会自动剥掉）。
//
// 用到的埋点字段：
//   - 捕获尝试（放弃率分母）：{ event:"capture_attempt", id?:<inbox entry id>, kind, source, ok:<bool>, ts }
//       /capture 端点与 MCP 写工具（save/todo_add/collections_upsert/remember/todo_done/remove）每次投递记一条。
//       成功带 id（用于 join keeper 去向）；失败（参数缺失 / addEntry 抛错如凭据红线）ok:false 且无 id。
//   - keeper 捕获去向： { tool:"keeper", entry:<id>, kind, disposition:"accepted|candidate|held|rejected", ts }
//       每处理一次一条；同一 entry 可出现多次（先 held、后被裁定再 accepted），以最后一条为「最终去向」。
//   - 被裁定耗时（held→resolve）：裁定事件带 { event:"ruling", held_ms:<毫秒>, resolved_at, ts }
//       held_ms = 从件被 keeper held 到主人裁定的时长；件此前没被 held 过则不带该字段（跳过）。
//   - 检索命中： { tool:"search", hit:<bool>, result_count:<n>, query?:<原文截断>, ts }
//
// 输出两条曲线（按天或按周分桶）：
//   曲线 1：held 半衰期（各桶内 held→裁定的中位时长）+ 捕获放弃率
//   曲线 2：检索落空率（hit=false 占比）
//
// 口径（capture abandonment rate / 捕获放弃率）—— spec §0「App/端点发起却没进库」：
//   分母 = 该桶内的捕获尝试数（capture_attempt，按 attempt 自身 ts 分桶）——不是 keeper 流水事件，
//          因为「参数缺失被 400 / 落盘前被凭据红线拒」的尝试根本进不了 keeper，却确确实实是「发起了没进库」。
//   join：成功的 attempt 按 id 关联 keeper 的「最终去向」。
//   分子（没进库）= (a) 失败的 attempt（ok:false，从没进 inbox） + (b) 最终去向 rejected（keeper 或主人裁定拒收）。
//   进库 = 最终 accepted/candidate；在途 = 仍 held 或 keeper 尚无记录。
//   即 放弃率 = 没进库 / 捕获尝试。
//   注意：仍停在 held（尚未被裁定）的尝试计入分母、不计入分子——它们是「在途待定夺」，由 held 半衰期曲线
//   单独度量；held 堆积会短暂压低放弃率，看两条曲线要合着读。
//
// held 半衰期（held half-life）算法：
//   取该桶（按裁定发生的日期分桶）内所有裁定事件的 held_ms，排序取中位数，换算成小时。
//
// 分桶时区：默认全程 UTC（防跨机时区漂移）。可传 --tz=±HH:MM 数字偏移（零依赖，无 IANA 库）把分桶
//   切到本地日界，如 --tz=+08:00 按东八区分「天/周」；表头会标注当前分桶时区。
//
// 用法：
//   node scripts/metrics.js [审计日志路径] [--by=day|week] [--tz=+08:00]
//   AUDIT_FILE=/data/audit.log node scripts/metrics.js
//   node scripts/metrics.js --help

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISPOSITIONS = new Set(['accepted', 'candidate', 'held', 'rejected']);
const IN_LIBRARY = new Set(['accepted', 'candidate']); // 视为「已进库」的最终去向

function printHelp() {
  // 直接把文件头部的注释块当 --help（保持单一真相）
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const header = src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  process.stdout.write(header + '\n');
}

// --tz 的数字偏移解析：±HH:MM / ±HHMM / ±HH / ±H（如 +08:00、-05:30、+8）→ 分钟偏移；非法返回 null。
// 零依赖，不认 IANA 时区名（那需要库）——只做纯数字偏移。
function parseTzOffset(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3] ?? '0');
  if (hh > 14 || mm > 59) return null; // 现实时区偏移上限 ±14:00
  return (m[1] === '-' ? -1 : 1) * (hh * 60 + mm);
}

function parseArgs(argv) {
  const opts = { file: process.env.AUDIT_FILE || null, by: 'day', tzMin: 0, tzLabel: 'UTC' };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--by=')) opts.by = a.slice(5);
    else if (a.startsWith('--tz=')) {
      const raw = a.slice(5);
      const off = parseTzOffset(raw);
      if (off !== null) { opts.tzMin = off; opts.tzLabel = `UTC${raw.startsWith('-') ? '' : (raw.startsWith('+') ? '' : '+')}${raw}`; }
    }
    else if (a.startsWith('--')) { /* 忽略未知开关 */ }
    else opts.file = a;
  }
  if (opts.by !== 'day' && opts.by !== 'week') opts.by = 'day';
  return opts;
}

// 一行 → JSON 对象；坏行 / 空行返回 null（宽容跳过）
function parseLine(line) {
  let s = line.trim();
  if (!s) return null;
  if (s.startsWith('AUDIT ')) s = s.slice(6); // 兼容 stdout 日志前缀
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

function readEvents(file) {
  if (!file) return { events: [], error: '未指定审计日志（传路径参数或设 AUDIT_FILE）' };
  if (!existsSync(file)) return { events: [], error: `审计日志不存在：${file}` };
  const text = readFileSync(file, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    const o = parseLine(line);
    if (o) events.push(o);
  }
  return { events, error: null };
}

// ts → 分桶键（day: YYYY-MM-DD；week: 该周周一的 YYYY-MM-DD）。
// 默认 UTC；offsetMin 为 --tz 的分钟偏移，先把时刻平移再用 UTC 分量取「本地日界」（零依赖）。
function bucketKey(ts, by, offsetMin = 0) {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + offsetMin * 60_000);
  if (by === 'week') {
    const dow = (d.getUTCDay() + 6) % 7; // 周一=0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function msToHuman(ms) {
  if (ms == null) return '-';
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60_000;
  if (m >= 1) return `${m.toFixed(0)}m`;
  return `${(ms / 1000).toFixed(0)}s`;
}

function pct(n, d) {
  if (!d) return '-';
  return `${((n / d) * 100).toFixed(1)}%`;
}

// 简单 ASCII 比例条（宽 width，rate ∈ [0,1]）
function bar(rate, width = 16) {
  if (rate == null) return ' '.repeat(width);
  const fill = Math.round(Math.max(0, Math.min(1, rate)) * width);
  return '#'.repeat(fill) + '·'.repeat(width - fill);
}

function padEnd(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function padStart(s, n) { s = String(s); return ' '.repeat(Math.max(0, n - s.length)) + s; }

// ---- 曲线 1：held 半衰期 + 捕获放弃率 ----
function computeCurve1(events, by, offsetMin = 0) {
  // keeper 最终去向：entry id → 最晚 ts 的 disposition（供 capture_attempt 按 id join）
  const finalDisp = new Map();
  for (const e of events) {
    if (e.tool !== 'keeper') continue;
    if (!DISPOSITIONS.has(e.disposition)) continue;
    if (typeof e.entry !== 'string' || typeof e.ts !== 'string') continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    const g = finalDisp.get(e.entry);
    if (!g || t >= g.t) finalDisp.set(e.entry, { t, disp: e.disposition });
  }

  const buckets = new Map(); // key → { attempts, inLib, held, abandoned, heldMs:[] }
  const ensure = (k) => {
    if (!buckets.has(k)) buckets.set(k, { attempts: 0, inLib: 0, held: 0, abandoned: 0, heldMs: [] });
    return buckets.get(k);
  };

  // 捕获尝试：每条 capture_attempt 一个「发起」，按 attempt 自身 ts 分桶（spec §0 的分母）
  for (const e of events) {
    if (e.event !== 'capture_attempt') continue;
    const k = bucketKey(e.ts, by, offsetMin);
    if (!k) continue;
    const b = ensure(k);
    b.attempts++;
    // 失败 / 无 id：从没进 inbox → 没进库（放弃）
    if (e.ok === false || typeof e.id !== 'string') { b.abandoned++; continue; }
    const fin = finalDisp.get(e.id);
    if (!fin) { b.held++; continue; }            // keeper 尚无记录 → 在途
    if (fin.disp === 'rejected') b.abandoned++;  // 最终拒收 → 没进库
    else if (fin.disp === 'held') b.held++;      // 仍 held → 在途（进分母不进分子）
    else if (IN_LIBRARY.has(fin.disp)) b.inLib++;// accepted/candidate → 进库
    else b.held++;
  }

  // 裁定耗时：按裁定发生日期（resolved_at 优先，退回 ts）分桶
  for (const e of events) {
    if (typeof e.held_ms !== 'number' || !(e.held_ms >= 0)) continue;
    const k = bucketKey(e.resolved_at || e.ts, by, offsetMin);
    if (!k) continue;
    ensure(k).heldMs.push(e.held_ms);
  }

  return buckets;
}

// ---- 曲线 2：检索落空率 ----
function computeCurve2(events, by, offsetMin = 0) {
  const buckets = new Map(); // key → { searches, misses }
  for (const e of events) {
    if (e.tool !== 'search') continue;
    // 命中口径：优先 hit 字段，缺失则退回 result_count
    let hit;
    if (typeof e.hit === 'boolean') hit = e.hit;
    else if (typeof e.result_count === 'number') hit = e.result_count > 0;
    else continue; // 旧条目没埋点 → 跳过
    const k = bucketKey(e.ts, by, offsetMin);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, { searches: 0, misses: 0 });
    const b = buckets.get(k);
    b.searches++;
    if (!hit) b.misses++;
  }
  return buckets;
}

function renderCurve1(buckets) {
  const lines = [];
  lines.push('曲线 1：held 半衰期 + 捕获放弃率（分母=捕获尝试）');
  if (!buckets.size) { lines.push('  （无数据）'); return lines.join('\n'); }
  const H = ['桶', '捕获', '进库', '在途', '没进库', '放弃率', 'held半衰期(中位)', '放弃率条'];
  const W = [10, 6, 6, 6, 6, 8, 16, 16];
  lines.push('  ' + H.map((h, i) => (i <= 1 ? padEnd(h, W[i]) : padStart(h, W[i]))).join(' '));
  for (const k of [...buckets.keys()].sort()) {
    const b = buckets.get(k);
    const rate = b.attempts ? b.abandoned / b.attempts : null;
    const row = [
      padEnd(k, W[0]),
      padStart(b.attempts, W[1]),
      padStart(b.inLib, W[2]),
      padStart(b.held, W[3]),
      padStart(b.abandoned, W[4]),
      padStart(pct(b.abandoned, b.attempts), W[5]),
      padStart(msToHuman(median(b.heldMs)), W[6]),
      padEnd(bar(rate), W[7]),
    ];
    lines.push('  ' + row.join(' '));
  }
  return lines.join('\n');
}

function renderCurve2(buckets) {
  const lines = [];
  lines.push('曲线 2：检索落空率');
  if (!buckets.size) { lines.push('  （无数据）'); return lines.join('\n'); }
  const H = ['桶', '检索', '落空', '落空率', '落空率条'];
  const W = [10, 6, 6, 8, 16];
  lines.push('  ' + H.map((h, i) => (i === 0 ? padEnd(h, W[i]) : padStart(h, W[i]))).join(' '));
  for (const k of [...buckets.keys()].sort()) {
    const b = buckets.get(k);
    const rate = b.searches ? b.misses / b.searches : null;
    const row = [
      padEnd(k, W[0]),
      padStart(b.searches, W[1]),
      padStart(b.misses, W[2]),
      padStart(pct(b.misses, b.searches), W[3]),
      padEnd(bar(rate), W[4]),
    ];
    lines.push('  ' + row.join(' '));
  }
  return lines.join('\n');
}

export function computeMetrics(events, by = 'day', offsetMin = 0) {
  return { curve1: computeCurve1(events, by, offsetMin), curve2: computeCurve2(events, by, offsetMin) };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }
  const { events, error } = readEvents(opts.file);
  if (error) {
    process.stdout.write(error + '\n（--help 看用法）\n');
    process.exitCode = 1;
    return;
  }
  const { curve1, curve2 } = computeMetrics(events, opts.by, opts.tzMin);
  const out = [
    `# substrate 使用仪表（源：${opts.file}，分桶：${opts.by}（${opts.tzLabel}），事件：${events.length}）`,
    '',
    renderCurve1(curve1),
    '',
    renderCurve2(curve2),
    '',
  ].join('\n');
  process.stdout.write(out);
}

// 直接运行时才跑 main（被 import 时只导出纯函数，方便测试）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
