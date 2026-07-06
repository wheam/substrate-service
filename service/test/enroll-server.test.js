// M4.8 server 接线：/enroll 兑换端点 + 主频道 enroll_create/list/revoke + identify 两源合并。
// 仿 server.test.js 起真端口 + MCP SDK client；audit/notify 用注入收集数组断言（不含明文）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createEnrollment } from '../src/enroll.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const instanceDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
// primary = 主频道（可铸码）；high = 普通高信任（对照，无 enroll_*）；low = 只读（对照）。
const TOKENS = {
  'test-token-primary': { client: 'cc-primary', trust: 'high', channel: 'primary' },
  'test-token-high': { client: 'cc-high', trust: 'high' },
  'test-token-low': { client: 'cc-low', trust: 'low' },
};

const servers = [];
after(() => { for (const s of servers) s.close(); });

function freshStatePath() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'enroll-srv-')), 'enroll-state.json');
}

// 每用例起一个独立 app（隔离限速桶与账本），注入 audit/notify 收集数组。
async function startApp(opts = {}) {
  const audit = [];
  const notify = [];
  const enrollment = opts.enrollment ?? createEnrollment({ statePath: freshStatePath() });
  const app = createApp({
    instanceDir,
    tokens: opts.tokens ?? TOKENS,
    audit: (e) => audit.push(e),
    notify: (t) => notify.push(t),
    enrollment,
    ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, audit, notify, enrollment, server };
}

async function mcpClient(baseUrl, token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function rawMcpInit(baseUrl, token) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
}

function postEnroll(baseUrl, code) {
  return fetch(`${baseUrl}/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(code === undefined ? {} : { code }),
  });
}

const extractCode = (text) => {
  const m = text.match(/sbe_[0-9a-f]+/);
  assert.ok(m, `响应文本应含可粘贴的 sbe_ 码：${text}`);
  return m[0];
};

async function mintCode(baseUrl, primaryClient, args) {
  const r = await primaryClient.callTool({ name: 'enroll_create', arguments: args });
  return extractCode(r.content[0].text);
}

test('GET /enroll：公开无认证 200，含 enrollment 码与 mcp add 指引，无 sbk_/sbe_ 实值', async () => {
  const { baseUrl } = await startApp();
  const res = await fetch(`${baseUrl}/enroll`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.match(text, /enrollment 码|一次性码/);
  assert.match(text, /mcp add/);
  // 占位符（sbe_你的码 / sbk_…）允许出现，但绝不能有 8+ 位十六进制的真实值
  assert.ok(!/sb[ek]_[0-9a-f]{8}/.test(text), '不得含任何真实 code/token 值');
});

test('全链路：primary enroll_create → POST /enroll 兑 token → search 读通 → enroll_list 见之 → enroll_revoke → 401', async () => {
  const { baseUrl } = await startApp();
  const primary = await mcpClient(baseUrl, 'test-token-primary');

  const created = await primary.callTool({ name: 'enroll_create', arguments: { client: 'hermes-new', trust: 'high' } });
  const code = extractCode(created.content[0].text);

  const redeem = await postEnroll(baseUrl, code);
  assert.equal(redeem.status, 200);
  const body = await redeem.json();
  assert.equal(body.ok, true);
  assert.match(body.token, /^sbk_/);
  assert.equal(body.client, 'hermes-new');
  assert.equal(body.trust, 'high');
  assert.match(body.mcp_url, /\/mcp$/);
  assert.match(body.digest_url, /\/digest$/);

  const newAgent = await mcpClient(baseUrl, body.token);
  const s = await newAgent.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  assert.match(s.content[0].text, /coffee-brewing/);
  await newAgent.close();

  const listed = await primary.callTool({ name: 'enroll_list', arguments: {} });
  assert.match(listed.content[0].text, /hermes-new/);

  const revoked = await primary.callTool({ name: 'enroll_revoke', arguments: { client: 'hermes-new' } });
  assert.ok(!revoked.isError, revoked.content?.[0]?.text);
  await primary.close();

  const afterRevoke = await rawMcpInit(baseUrl, body.token);
  assert.equal(afterRevoke.status, 401);
});

test('工具面收窄：非 primary 的 high 无 enroll_*；low 无 enroll_*；primary 三件齐', async () => {
  const { baseUrl } = await startApp();

  const primary = await mcpClient(baseUrl, 'test-token-primary');
  const pNames = (await primary.listTools()).tools.map((t) => t.name);
  assert.ok(['enroll_create', 'enroll_list', 'enroll_revoke'].every((n) => pNames.includes(n)), `primary 应有 enroll_*：${pNames}`);
  await primary.close();

  const high = await mcpClient(baseUrl, 'test-token-high');
  const hNames = (await high.listTools()).tools.map((t) => t.name);
  assert.ok(!hNames.some((n) => n.startsWith('enroll_')), `非 primary high 不应有 enroll_*：${hNames}`);
  await high.close();

  const low = await mcpClient(baseUrl, 'test-token-low');
  const lNames = (await low.listTools()).tools.map((t) => t.name);
  assert.ok(!lNames.some((n) => n.startsWith('enroll_')), `low 不应有 enroll_*：${lNames}`);
  await low.close();
});

test('防提权：enroll_create trust=primary/admin 报错；兑出的 low token 无 get_context', async () => {
  const { baseUrl } = await startApp();
  const primary = await mcpClient(baseUrl, 'test-token-primary');

  const p = await primary.callTool({ name: 'enroll_create', arguments: { client: 'x1', trust: 'primary' } });
  assert.equal(p.isError, true);
  const a = await primary.callTool({ name: 'enroll_create', arguments: { client: 'x2', trust: 'admin' } });
  assert.equal(a.isError, true);

  // 铸 low 码 → 兑换 → 关键：兑出的 token 必须真是 low（防 wrap 的 identity.trust 注入把 low 提成 high）
  const code = await mintCode(baseUrl, primary, { client: 'reader', trust: 'low' });
  await primary.close();
  const body = await (await postEnroll(baseUrl, code)).json();
  assert.equal(body.trust, 'low', '兑出的 token 信任档必须是铸码时指定的 low');

  const reader = await mcpClient(baseUrl, body.token);
  const names = (await reader.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('get_context'), `low token 不应有 get_context：${names}`);
  await reader.close();
});

test('缺参：POST /enroll 无 code → 400', async () => {
  const { baseUrl } = await startApp();
  const res = await postEnroll(baseUrl, undefined);
  assert.equal(res.status, 400);
});

test('重放：同码二次 POST → 410 used + audit reason:used + notify 抢注提醒', async () => {
  const { baseUrl, audit, notify } = await startApp();
  const primary = await mcpClient(baseUrl, 'test-token-primary');
  const code = await mintCode(baseUrl, primary, { client: 'twice', trust: 'high' });
  await primary.close();

  const first = await postEnroll(baseUrl, code);
  assert.equal(first.status, 200);
  const second = await postEnroll(baseUrl, code);
  assert.equal(second.status, 410);

  assert.ok(audit.some((e) => e.event === 'enroll_rejected' && e.reason === 'used'), 'audit 应记 enroll_rejected reason:used');
  assert.ok(notify.some((t) => /已被使用|抢注|重放/.test(t)), 'notify 应含抢注/重放提醒');
});

test('过期：codeTtlMs=1 的实例 → POST → 410 expired', async () => {
  const enrollment = createEnrollment({ statePath: freshStatePath(), codeTtlMs: 1 });
  const { baseUrl, audit } = await startApp({ enrollment });
  const primary = await mcpClient(baseUrl, 'test-token-primary');
  const code = await mintCode(baseUrl, primary, { client: 'slow', trust: 'high' });
  await primary.close();

  await new Promise((r) => setTimeout(r, 10));
  const res = await postEnroll(baseUrl, code);
  assert.equal(res.status, 410);
  assert.ok(audit.some((e) => e.event === 'enroll_rejected' && e.reason === 'expired'));
});

test('限速：连发 6 个瞎码 → 第 6 个 429 + audit reason:rate_limited', async () => {
  const { baseUrl, audit } = await startApp();
  let last;
  for (let i = 0; i < 6; i++) {
    last = await postEnroll(baseUrl, `sbe_deadbeefdeadbeef000000000000000${i}`);
  }
  assert.equal(last.status, 429);
  assert.ok(audit.some((e) => e.event === 'enroll_rejected' && e.reason === 'rate_limited'), 'audit 应记 rate_limited');
});

test('限速全局桶：跨 IP 轮换伪造 XFF 绕过 per-IP，合计 30 次失败后一律 429', async () => {
  const { baseUrl, audit } = await startApp();
  let last;
  // 每次换一个 XFF（per-IP 桶各自 ≤3 次、永不到 5），但全局失败桶累计到 30 → 第 31 个一律 429。
  for (let i = 0; i <= 30; i++) {
    last = await fetch(`${baseUrl}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i % 10}` },
      body: JSON.stringify({ code: `sbe_beef${i}` }),
    });
  }
  assert.equal(last.status, 429);
  assert.ok(audit.some((e) => e.event === 'enroll_rejected' && e.reason === 'rate_limited'), 'audit 应记 rate_limited（全局桶）');
});

test('静态优先/零回归：静态 high token handshake instructions 正常 + search 读通', async () => {
  const { baseUrl } = await startApp();
  const client = await mcpClient(baseUrl, 'test-token-high');
  assert.match(client.getInstructions() ?? '', /查无不编|没存过/);
  const s = await client.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  assert.match(s.content[0].text, /coffee-brewing/);
  await client.close();
});

test('无明文外泄：全链路后 audit+notify 整体 JSON 不含 code/token 实值', async () => {
  const { baseUrl, audit, notify } = await startApp();
  const primary = await mcpClient(baseUrl, 'test-token-primary');
  const code = await mintCode(baseUrl, primary, { client: 'leaky', trust: 'high' });
  const body = await (await postEnroll(baseUrl, code)).json();
  const token = body.token;

  const na = await mcpClient(baseUrl, token);
  await na.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  await na.close();
  await primary.callTool({ name: 'enroll_list', arguments: {} });
  await primary.callTool({ name: 'enroll_revoke', arguments: { client: 'leaky' } });
  await primary.close();

  const blob = JSON.stringify(audit) + JSON.stringify(notify);
  assert.ok(!blob.includes(code), 'audit/notify 不得含 code 实值');
  assert.ok(!blob.includes(token), 'audit/notify 不得含 token 实值');
});

test('重启持久化：同 statePath 新建 app，老 token 仍 MCP 读通', async () => {
  const statePath = freshStatePath();
  const { baseUrl: url1 } = await startApp({ enrollment: createEnrollment({ statePath }) });
  const primary = await mcpClient(url1, 'test-token-primary');
  const code = await mintCode(url1, primary, { client: 'persist', trust: 'high' });
  await primary.close();
  const body = await (await postEnroll(url1, code)).json();
  const token = body.token;

  // 新 app、同 statePath、新 enrollment 实例（模拟重启）
  const { baseUrl: url2 } = await startApp({ enrollment: createEnrollment({ statePath }) });
  const reconnected = await mcpClient(url2, token);
  const s = await reconnected.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  assert.match(s.content[0].text, /coffee-brewing/);
  await reconnected.close();
});
