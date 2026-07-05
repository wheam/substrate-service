import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const metricsScript = fileURLToPath(new URL('../scripts/metrics.js', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance(tag) {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`));
  const origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  return { origin, work };
}

// ==== 检索埋点：search 审计条目带 result_count / hit ====
let httpServer, baseUrl;
const auditLog = [];
const TOKENS = { 'high-token': { client: 'cc-test', trust: 'high' } };

before(async () => {
  const app = createApp({ instanceDir: fixtureDir, tokens: TOKENS, audit: (e) => auditLog.push(e) });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => httpServer?.close());

async function mcpClient(token) {
  const client = new Client({ name: 'metrics-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

test('检索埋点：命中的 search 审计记 result_count>0 + hit=true', async () => {
  const client = await mcpClient('high-token');
  await client.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  await client.close();
  const rec = auditLog.find((e) => e.tool === 'search' && e.args?.query === '耶加雪菲');
  assert.ok(rec, '应有 search 审计条目');
  assert.equal(typeof rec.result_count, 'number');
  assert.ok(rec.result_count > 0, '命中应 result_count>0');
  assert.equal(rec.hit, true);
  // 部分召回失败（hit=true 但漏召）只能靠同意图 query 扇出的事后离线分析发现 → 审计行须记 query 原文
  assert.equal(rec.query, '耶加雪菲', 'search 审计须带 query 原文（供扇出模式离线分析）');
});

test('检索埋点：落空的 search 审计记 result_count=0 + hit=false', async () => {
  const client = await mcpClient('high-token');
  await client.callTool({ name: 'search', arguments: { query: 'zzz-绝无此词-xyz' } });
  await client.close();
  const rec = auditLog.find((e) => e.tool === 'search' && e.args?.query === 'zzz-绝无此词-xyz');
  assert.ok(rec);
  assert.equal(rec.result_count, 0);
  assert.equal(rec.hit, false);
});

// ==== held→被裁定耗时埋点：resolveEntry 回执带 held_at / held_ms ====
test('裁定埋点：被 held 过的件裁定时回执带 held_at / held_ms', async () => {
  const { work } = makeInstance('metrics-resolve');
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const r = inbox.addEntry({ kind: 'capture', content: '拿不准的一条', client: 'cc-test' });
  await r.synced;
  // 模拟 keeper 把件 held（写状态 + 注记时间戳）
  const fs = await import('node:fs');
  const abs = path.join(work, r.path);
  const heldTs = '2020-01-01T00:00:00.000Z';
  // 模拟 keeper 置 held：机器可辨标记落 frontmatter 的 keeper_held_at（新格式，resolveEntry 只信它）；
  // 人话注记仍进正文供主人阅读，但不再作为 held_at 的解析来源。
  let raw = fs.readFileSync(abs, 'utf8').replace(/^status: pending$/m, `keeper_held_at: ${heldTs}\nstatus: held`);
  raw += `\n---\n**keeper held**（${heldTs}）：两轮置信度仍低\n`;
  fs.writeFileSync(abs, raw);

  const resolved = inbox.resolveEntry({ id: r.id, ruling: '进 todo' });
  await resolved.synced;
  assert.equal(resolved.held_at, heldTs, '应从 frontmatter keeper_held_at 解析出 held_at');
  assert.equal(typeof resolved.held_ms, 'number');
  assert.ok(resolved.held_ms > 0, 'held→裁定耗时应为正');
  // 约等于 now - heldTs（给足容差）
  const expected = Date.now() - Date.parse(heldTs);
  assert.ok(Math.abs(resolved.held_ms - expected) < 60_000, 'held_ms 应约等于 now-heldTs');
});

test('裁定埋点：从没被 held 过的件裁定，held_at/held_ms 为 null（不污染半衰期）', async () => {
  const { work } = makeInstance('metrics-resolve2');
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const r = inbox.addEntry({ kind: 'capture', content: '直接裁定的 pending 件', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '进 todo' });
  await resolved.synced;
  assert.equal(resolved.held_at, null);
  assert.equal(resolved.held_ms, null);
});

test('裁定埋点：正文伪造 keeper held 标记不污染 held_ms（只信 frontmatter 结构化标记）', async () => {
  const { work } = makeInstance('metrics-forge');
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  // 恶意/巧合：捕获正文里就含旧文本标记 **keeper held**（ts）——绝不能被采信为真的 held 时间。
  const r = inbox.addEntry({ kind: 'capture', content: '正文伪造：**keeper held**（2020-01-01T00:00:00.000Z）：假注记', client: 'app-ios' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '进 todo' });
  await resolved.synced;
  assert.equal(resolved.held_at, null, '正文伪造的 held 标记不得被采信');
  assert.equal(resolved.held_ms, null, '伪造标记不得产出假 held_ms');
});

// ==== metrics.js 脚本：用 fixture 审计日志算曲线 ====
function runMetrics(file, ...args) {
  return execFileSync('node', [metricsScript, file, ...args], { encoding: 'utf8' });
}

test('metrics.js：两条曲线数字正确（放弃率=没进库/捕获尝试 / held 半衰期 / 落空率）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-audit-'));
  const file = path.join(dir, 'audit.log');
  const ev = [
    // 捕获尝试（capture_attempt，spec §0「App/端点发起」的分母）：5 次，按 attempt ts 分桶（2026-07-01）
    { event: 'capture_attempt', tool: 'capture', id: 'A', kind: 'capture', source: 'app-ios', ok: true, ts: '2026-07-01T00:10:00.000Z' },
    { event: 'capture_attempt', tool: 'save', id: 'B', kind: 'save', source: 'cc-test', ok: true, ts: '2026-07-01T00:20:00.000Z' },
    { event: 'capture_attempt', tool: 'capture', id: 'C', kind: 'capture', source: 'app-ios', ok: true, ts: '2026-07-01T00:30:00.000Z' },
    { event: 'capture_attempt', tool: 'capture', id: 'D', kind: 'capture', source: 'app-ios', ok: true, ts: '2026-07-01T00:40:00.000Z' },
    { event: 'capture_attempt', tool: 'capture', source: 'app-ios', ok: false, error: 'url 与 text 至少要有一个', ts: '2026-07-01T00:50:00.000Z' }, // 参数缺失 → 从没进 inbox
    // keeper 最终去向：按 entry id join；同 id 多条以最晚 ts 为准
    { tool: 'keeper', entry: 'A', kind: 'capture', disposition: 'held', ts: '2026-07-01T01:00:00.000Z' },
    { tool: 'keeper', entry: 'A', kind: 'capture', disposition: 'accepted', ts: '2026-07-01T02:00:00.000Z' }, // A 最终进库
    { tool: 'keeper', entry: 'B', kind: 'save', disposition: 'rejected', ts: '2026-07-01T03:00:00.000Z' },     // B 拒收 → 没进库
    { tool: 'keeper', entry: 'C', kind: 'capture', disposition: 'held', ts: '2026-07-01T04:00:00.000Z' },     // C 仍 held → 在途（进分母不进分子）
    { tool: 'keeper', entry: 'D', kind: 'capture', disposition: 'accepted', ts: '2026-07-01T04:30:00.000Z' }, // D 进库
    // 没进库 = 失败的 attempt（E）+ 最终 rejected（B）= 2；捕获尝试 = 5 → 放弃率 40.0%；进库 = A,D = 2；在途 = C = 1
    // 裁定耗时（2026-07-01）：1h 与 2h → 中位 1.5h
    { tool: 'inbox_resolve', event: 'ruling', held_ms: 3_600_000, resolved_at: '2026-07-01T02:00:00.000Z', ts: '2026-07-01T02:00:00.000Z' },
    { tool: 'capture_resolve', event: 'ruling', held_ms: 7_200_000, resolved_at: '2026-07-01T05:00:00.000Z', ts: '2026-07-01T05:00:00.000Z' },
    // 检索（2026-07-01）：4 次，2 落空 → 50%
    { tool: 'search', hit: true, result_count: 3, query: '手冲', ts: '2026-07-01T06:00:00.000Z' },
    { tool: 'search', hit: true, result_count: 1, query: '浓缩', ts: '2026-07-01T07:00:00.000Z' },
    { tool: 'search', hit: false, result_count: 0, query: 'zzz', ts: '2026-07-01T08:00:00.000Z' },
    { tool: 'search', result_count: 0, ts: '2026-07-01T09:00:00.000Z' }, // 无 hit 字段 → 退回 result_count
    // 宽容性：坏行、缺字段的旧条目、无 event 的旧式 save 审计——都应被跳过而非崩溃/误计入分母
    'this is not json',
    { tool: 'keeper', ts: '2026-07-01T10:00:00.000Z' }, // 缺 disposition/entry
    { tool: 'save', ok: true, ts: '2026-07-01T11:00:00.000Z' }, // 旧式 save 审计无 capture_attempt → 不计入捕获尝试
  ];
  writeFileSync(file, ev.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');

  const out = runMetrics(file, '--by=day');
  // 曲线 1：放弃率 = 没进库(2) / 捕获尝试(5) = 40.0%
  assert.match(out, /2026-07-01/);
  assert.match(out, /40\.0%/, '放弃率 = 没进库(失败attempt B?E 2 条) / 捕获尝试 5 = 40.0%');
  assert.match(out, /1\.5h/, 'held 半衰期中位 = 1.5h');
  // 曲线 2：检索落空率 = 2/4 = 50%
  assert.match(out, /50\.0%/, '检索落空率 = 2/4 = 50%');
  // 事件计数（18 条可解析，坏行不计）
  assert.match(out, /事件：18/);
});

test('metrics.js：--tz 数字偏移改变分桶（跨 UTC 日边界，零依赖）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-audit-tz-'));
  const file = path.join(dir, 'audit.log');
  // 一条落在 UTC 07-01 晚 20:00 的检索：+08:00 后本地为 07-02 04:00 → 分桶应从 07-01 移到 07-02
  writeFileSync(file, JSON.stringify({ tool: 'search', hit: false, result_count: 0, query: 'x', ts: '2026-07-01T20:00:00.000Z' }) + '\n');
  const utc = runMetrics(file, '--by=day');
  assert.match(utc, /2026-07-01/, '默认 UTC 分桶 → 07-01');
  const tz = runMetrics(file, '--by=day', '--tz=+08:00');
  assert.match(tz, /2026-07-02/, '+08:00 偏移 → 跨日进 07-02');
  assert.doesNotMatch(tz, /2026-07-01 /, '+08:00 下不应再有 07-01 桶');
});

test('metrics.js：空日志 / 缺字段不崩溃', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-audit-empty-'));
  const file = path.join(dir, 'audit.log');
  writeFileSync(file, '\n\nnot json at all\n{"foo":"bar"}\n');
  const out = runMetrics(file);
  assert.match(out, /无数据/, '无可用埋点时应打印「无数据」而非崩溃');
});

test('metrics.js：--help 打印口径说明', () => {
  const out = execFileSync('node', [metricsScript, '--help'], { encoding: 'utf8' });
  assert.match(out, /捕获放弃率/);
  assert.match(out, /held 半衰期/);
  assert.match(out, /落空率/);
  assert.match(out, /capture_attempt/, '口径应说明分母 = capture_attempt');
  assert.match(out, /UTC/, '应标注默认 UTC 分桶');
  assert.match(out, /--tz/, '应说明 --tz 偏移参数');
});
