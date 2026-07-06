import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const instanceDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = {
  'test-token-high': { client: 'cc-test', trust: 'high' },
  'test-token-low': { client: 'stranger', trust: 'low' },
};

let httpServer;
let baseUrl;

before(async () => {
  const app = createApp({ instanceDir, tokens: TOKENS });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => httpServer?.close());

async function mcpClient(token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

test('healthz 无需认证', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
});

test('无 token / 错 token 拒绝 MCP 请求', async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
  assert.equal(res.status, 401);
  const res2 = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: 'Bearer wrong' },
    body: '{}',
  });
  assert.equal(res2.status, 401);
});

test('initialize 下发 server instructions（行为契约）', async () => {
  const client = await mcpClient('test-token-high');
  const instructions = client.getInstructions();
  assert.ok(instructions, '应有 instructions');
  assert.match(instructions, /查无不编|没存过/);
  assert.match(instructions, /get_context|search/);
  await client.close();
});

test('tools/list：高信任 = 5 读 + 7 写（含 schema_propose/apply、page_set_tier）；低信任只有读且无 sensitive 通路', async () => {
  const client = await mcpClient('test-token-high');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'collections_search', 'collections_upsert', 'get_context', 'inbox_list', 'inbox_resolve',
    'page_set_tier', 'read_page', 'remember', 'remove', 'save', 'schema_apply', 'schema_propose', 'search',
    'todo_add', 'todo_done', 'todo_list',
  ]);
  await client.close();

  const low = await mcpClient('test-token-low');
  const lowNames = (await low.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(lowNames, ['collections_search', 'read_page', 'search', 'todo_list']);
  await low.close();
});

test('高信任 token 全通路：search / todo_list / get_context', async () => {
  const client = await mcpClient('test-token-high');
  const s = await client.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
  assert.match(s.content[0].text, /coffee-brewing/);
  const t = await client.callTool({ name: 'todo_list', arguments: {} });
  assert.match(t.content[0].text, /柠檬树/);
  const c = await client.callTool({ name: 'get_context', arguments: {} });
  assert.match(c.content[0].text, /Alex/);
  await client.close();
});

test('低信任 token：get_context 连注册都没有、search 不见 sensitive', async () => {
  const client = await mcpClient('test-token-low');
  const c = await client.callTool({ name: 'get_context', arguments: {} });
  assert.equal(c.isError, true);
  assert.match(c.content[0].text, /not found/); // 未注册，而不是注册后拒绝
  const s = await client.callTool({ name: 'search', arguments: { query: '橡皮鸭' } });
  assert.match(s.content[0].text, /没有命中|\"results\": \[\]|results": \[\]/);
  await client.close();
});

test('审计：search 的 include 字段——用了非默认档才记（默认档不带该字段），旧字段只加不改', async () => {
  const auditLog = [];
  const app2 = createApp({ instanceDir, tokens: TOKENS, audit: (e) => auditLog.push(e) });
  const srv = await new Promise((res) => { const s = app2.listen(0, '127.0.0.1', () => res(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    const client = new Client({ name: 'audit-client', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer test-token-high' } },
    }));
    await client.callTool({ name: 'search', arguments: { query: '耶加雪菲' } });
    await client.callTool({ name: 'search', arguments: { query: '耶加雪菲', include: 'candidate,rejected' } });
    await client.close();
    const searchAudits = auditLog.filter((e) => e.tool === 'search');
    assert.equal(searchAudits.length, 2);
    assert.ok(!('include' in searchAudits[0]), '默认档不带 include 字段');
    assert.deepEqual(searchAudits[1].include, ['candidate', 'rejected'], '非默认档记录 include');
    // 旧字段仍在（只加不改）
    assert.equal(typeof searchAudits[1].result_count, 'number');
    assert.equal(typeof searchAudits[1].hit, 'boolean');
  } finally { srv.close(); }
});

test('GET /digest：高信任返回常驻小抄纯文本；低信任/capture 403；无 token 401', async () => {
  const ok = await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer test-token-high' } });
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.match(text, /Alex/);
  assert.match(text, /接入房规/, 'digest 应携带服务下发的接入房规');
  assert.match(text, /不要直接修改本地/, '房规应禁止直改本地 clone');
  assert.equal((await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer test-token-low' } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/digest`)).status, 401);
});
