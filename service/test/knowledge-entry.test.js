// 知识库入口与措辞契约（知识库易用性首批）：
// ① 入口自称：server title / instructions / 读工具描述都要把「我的知识库、保存过的规则、
//    个人偏好、此前的决定」前移到显眼处，并清晰路由 recall / search / read_page；
// ② 未命中 ≠ 没存过：instructions（含 /digest 与 enroll 独立副本）不得再教 agent 说「库里没存过」；
// ③ 核心读工具带正确的标准 annotations（readOnlyHint），写/管理工具绝不被标只读。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { BEHAVIOR_RULES, DIGEST_RULES, INSTRUCTIONS, instructionsFor, enrollProtocol } from '../src/instructions.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const instanceDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = {
  'entry-high': { client: 'cc-entry', trust: 'high' },
  'entry-low': { client: 'entry-stranger', trust: 'low' },
};

// 只读的假 provider：仅为让 recall 工具注册（本文件不断言任何模型答案）。
const stubProvider = { judge: async () => ({ json: { answer: '', citations: [], gaps: [] }, model: 'fake-offline' }) };

async function withClient(token, fn, { provider } = {}) {
  const app = createApp({ instanceDir, tokens: TOKENS, ...(provider ? { provider } : {}) });
  const httpServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const client = new Client({ name: 'entry-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  try { return await fn(client); } finally { await client.close(); httpServer.close(); }
}

// ==== ① 入口自称 ====

test('server 展示名为「个人知识库 · Substrate」，id/name/version 保持兼容', async () => {
  await withClient('entry-high', (client) => {
    const info = client.getServerVersion();
    assert.equal(info.name, 'substrate-kb', 'MCP id/name 不得变（兼容既有接入）');
    assert.equal(info.version, '0.2.0');
    assert.equal(info.title, '个人知识库 · Substrate');
  });
});

test('instructions 开头就把「我的知识库/保存过的规则/个人偏好/此前的决定」认领掉，并路由三个读工具', () => {
  const head = BEHAVIOR_RULES.slice(0, 400);
  for (const alias of ['我的知识库', '保存过的规则', '个人偏好', '此前的决定']) {
    assert.ok(head.includes(alias), `入口说明前 400 字应认领「${alias}」`);
  }
  assert.match(BEHAVIOR_RULES, /recall/, '自然语言综合 → recall');
  assert.match(BEHAVIOR_RULES, /search/, '关键词定位 → search');
  assert.match(BEHAVIOR_RULES, /read_page/, '整页全文 → read_page');
  assert.match(BEHAVIOR_RULES, /不要等主人明确说.*查知识库/s);
  assert.match(BEHAVIOR_RULES, /通用|无关/, '应写明与主人无关的通用问题不必查库');
  assert.ok(INSTRUCTIONS.includes(BEHAVIOR_RULES) && DIGEST_RULES.includes(BEHAVIOR_RULES),
    '在线/离线两条下发路仍复用同一份契约');
});

test('入口说明是删减前移而非再叠一层：通用房规只出现一次，权限/直写/裁定面规则不受损', () => {
  // 只数「行首的规则块标题」——正文里的交叉引用（如「按下方【捕获信号】」）不算重复下发。
  const blocks = (text, heading) => text.split('\n').filter((l) => l.startsWith(heading)).length;
  const direct = instructionsFor({ trust: 'high', channel: 'primary' }, { directWrite: true });
  assert.equal(blocks(direct, '【读库再答】'), 1, '通用房规不得重复下发');
  assert.equal(blocks(direct, '【捕获信号】'), 1);
  assert.equal(blocks(direct, '【查无不编】'), 1);
  assert.match(direct, /轻治理可信直写/, '直写授权规则必须保留');
  assert.match(direct, /主频道职责/, '主频道裁定面规则必须保留');
  assert.match(direct, /敏感边界/, '敏感边界规则必须保留');
  assert.ok(instructionsFor({ trust: 'high' }).length < 1691, '同一身份的共享说明应短于改造前的 1691 字符');
});

test('读工具描述把入口语义前移，且不在每个工具里重抄一遍通用房规', async () => {
  await withClient('entry-high', async (client) => {
    const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    assert.match(byName.search.description, /个人知识库/);
    assert.match(byName.search.description, /不要等主人明确说.*查知识库/s);
    assert.match(byName.read_page.description, /全文/);
    for (const t of Object.values(byName)) {
      assert.ok(!t.description.includes('【捕获信号】'), `${t.name} 不该重抄通用房规`);
      assert.ok(!t.description.includes('【读库再答】'), `${t.name} 不该重抄通用房规`);
    }
  }, { provider: stubProvider });
});

test('recall 工具描述认领「保存过的规则/个人偏好」并说明证据与截断字段', async () => {
  await withClient('entry-high', async (client) => {
    const recall = (await client.listTools()).tools.find((t) => t.name === 'recall');
    assert.ok(recall, '配了 provider 应注册 recall');
    assert.match(recall.description, /保存过的规则|个人偏好/);
    assert.match(recall.description, /evidence/);
    assert.match(recall.description, /truncated/);
    assert.match(recall.description, /read_page/, '证据不完整时应指路 read_page 补读');
  }, { provider: stubProvider });
});

// ==== ② 未命中 ≠ 没存过 ====

const FORBIDDEN_MISS_PHRASES = [/库里没存过/, /库里没有相关内容/, /直说「库里没有/];

test('BEHAVIOR_RULES：未命中措辞改为「未检索到足够依据」，不再教 agent 断言没存过', () => {
  for (const bad of FORBIDDEN_MISS_PHRASES) assert.doesNotMatch(BEHAVIOR_RULES, bad);
  assert.match(BEHAVIOR_RULES, /未检索到足够依据/);
  assert.match(BEHAVIOR_RULES, /不.*断言.*从未保存|不代表.*没存过|≠/s, '应明确未命中不等于没存过');
  assert.match(BEHAVIOR_RULES, /工具(报错|失败|出错)/, '服务/工具故障应与内容缺失分开表达');
  assert.match(BEHAVIOR_RULES, /绝不编造/, '查无不编的实质约束必须保留');
});

test('enroll 自助协议里的独立副本同步纠正', () => {
  const text = enrollProtocol('https://example.test');
  for (const bad of FORBIDDEN_MISS_PHRASES) assert.doesNotMatch(text, bad);
  assert.match(text, /未检索到足够依据/);
  assert.match(text, /已受理.*≠.*已入库/s, '回执语义不得被改坏');
});

test('/digest 与在线 instructions 下发同一份纠正后的措辞', async () => {
  const app = createApp({ instanceDir, tokens: TOKENS });
  const httpServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/digest`, {
      headers: { Authorization: 'Bearer entry-high' },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const bad of FORBIDDEN_MISS_PHRASES) assert.doesNotMatch(text, bad);
    assert.match(text, /未检索到足够依据/);
  } finally { httpServer.close(); }
});

// ==== ③ annotations ====

const READ_TOOLS = ['search', 'read_page', 'get_context', 'todo_list', 'collections_search', 'recall'];

test('握手工具表可断言：核心读工具带 readOnlyHint=true / openWorldHint=false', async () => {
  await withClient('entry-high', async (client) => {
    const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const name of READ_TOOLS) {
      assert.ok(byName[name], `应注册 ${name}`);
      assert.equal(byName[name].annotations?.readOnlyHint, true, `${name} 应标只读`);
      assert.equal(byName[name].annotations?.openWorldHint, false, `${name} 的作用域是主人的库（封闭世界）`);
    }
  }, { provider: stubProvider });
});

test('写/管理工具绝不被标只读', async () => {
  await withClient('entry-high', async (client) => {
    const tools = (await client.listTools()).tools;
    const writeTools = tools.filter((t) => !READ_TOOLS.includes(t.name));
    assert.ok(writeTools.length >= 8, '高信任应有一批写/管理工具');
    for (const t of writeTools) {
      assert.notEqual(t.annotations?.readOnlyHint, true, `${t.name} 是写/管理工具，不得标只读`);
    }
  }, { provider: stubProvider });
});

test('低信任握手也拿到同样的读工具 annotations', async () => {
  await withClient('entry-low', async (client) => {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length >= 4);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `低信任只应看到只读工具（${t.name}）`);
  });
});
