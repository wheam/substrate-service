import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
// tok-primary = 主频道客户端；tok-plain = 普通高信任（对照组）。capture+primary 的告警场景单独在
// 对应用例里构造 tokens（见「capture token 标 primary」），避免它的启动告警污染其它用例的输出。
const TOKENS = {
  'tok-primary': { client: 'cc-main', trust: 'high', channel: 'primary' },
  'tok-plain':   { client: 'cc-other', trust: 'high' },
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

const servers = [];
after(() => { for (const s of servers) s.close(); });

// 只读用例的工作副本：纯 cpSync（无 git，也无 inbox 目录）。各用例独立 base → 派生索引落各自 base 不撞车；
// nudge 的进程级 state 随各自新建的 app 天然隔离。
function freshWork() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-primary-'));
  const work = path.join(base, 'work');
  cpSync(fixtureDir, work, { recursive: true });
  return work;
}

// 仅 inbox_resolve 用例需要：resolveEntry 会 writer.commitAndPush，得有真 git 远端才不产生未处理 rejection。
// 自带独立 origin，push 不污染别的用例（否则共享 origin 会把已解析件带进后续 clone）。
function freshGitWork() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-primary-git-'));
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
  return work;
}

async function startApp(work, opts = {}) {
  const app = createApp({ instanceDir: work, tokens: TOKENS, ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, server };
}

async function mcpClient(baseUrl, token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

// held 件制造：直接往临时 instance 的 inbox/ 写 `_YYYY-MM-DD-<id>.md`，格式抄 inbox.js addEntry 输出，
// 仅把 status 改成 held。marker 放正文——用于断言 nudge/digest 绝不带件正文（对抗输入防注入）。
function writeHeld(work, id, { kind = 'save', marker = '', client = 'cc-main' } = {}) {
  const dir = path.join(work, 'inbox');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const fm = [
    '---',
    `title: 收件 ${id}`,
    `created: ${date}`,
    `updated: ${date}`,
    'type: inbox',
    `id: ${id}`,
    `received_at: ${now}`,
    `client: ${client}`,
    `kind: ${kind}`,
    'status: held',
    '---',
    '',
  ].join('\n');
  const abs = path.join(dir, `_${date}-${id}.md`);
  writeFileSync(abs, fm + marker + '\n');
  return abs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('primary 客户端 instructions 附主频道房规，普通客户端不附', async () => {
  const { baseUrl } = await startApp(freshWork());
  const primary = await mcpClient(baseUrl, 'tok-primary');
  assert.match(primary.getInstructions(), /主频道/);
  assert.match(primary.getInstructions(), /inbox_resolve/);
  await primary.close();
  const plain = await mcpClient(baseUrl, 'tok-plain');
  assert.ok(!/主频道/.test(plain.getInstructions()));
  await plain.close();
});

test('有 held 件时 primary 客户端工具响应尾部附待裁提示（不含件正文）', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1', { marker: 'INJECT-MARKER-XYZ' });
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const res = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  const text = res.content[0].text;
  assert.match(text, /📥 待主人裁定 1 件/);
  assert.ok(!text.includes('INJECT-MARKER-XYZ'), 'nudge 绝不带件正文（对抗输入防注入）');
  await client.close();
});

test('普通 high 客户端同一 held 状态下响应不含 📥', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1', { marker: 'INJECT-MARKER-XYZ' });
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-plain');
  const res = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.ok(!res.content[0].text.includes('📥'), '非主频道客户端不承担裁决面');
  await client.close();
});

test('primary 调 inbox_list / inbox_resolve 响应不附 nudge（正在处理中，附加是噪音）', async () => {
  const work = freshGitWork(); // inbox_resolve 会 commitAndPush，需真 git 远端
  writeHeld(work, 'held-1', { marker: 'INJECT-MARKER-XYZ' });
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const list = await client.callTool({ name: 'inbox_list', arguments: {} });
  assert.ok(!list.content[0].text.includes('📥'), 'inbox_list 不附 nudge');
  const resolved = await client.callTool({ name: 'inbox_resolve', arguments: { id: 'held-1', ruling: '进待办' } });
  assert.ok(!resolved.content[0].text.includes('📥'), 'inbox_resolve 不附 nudge');
  await client.close();
});

test('防重复：同一 held 集合第二次 callTool 不再附', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1');
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const first = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(first.content[0].text, /📥/);
  const second = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.ok(!second.content[0].text.includes('📥'), '同集合本会话只浮出一次');
  await client.close();
});

test('集合变化重发：新增一个 held 件后再调，附且计数=2', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1');
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const first = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(first.content[0].text, /📥 待主人裁定 1 件/);
  writeHeld(work, 'held-2', { kind: 'todo' });
  const second = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(second.content[0].text, /📥 待主人裁定 2 件/, 'held 集合变化即重发');
  await client.close();
});

test('TTL 重发：nudgeTtlMs 到期后同集合重新附', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1');
  const { baseUrl } = await startApp(work, { nudgeTtlMs: 50 });
  const client = await mcpClient(baseUrl, 'tok-primary');
  const first = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(first.content[0].text, /📥/);
  await sleep(60);
  const second = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(second.content[0].text, /📥/, 'TTL 过期后重新附');
  await client.close();
});

test('held 清空后不附', async () => {
  const work = freshWork();
  const heldPath = writeHeld(work, 'held-1');
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const first = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(first.content[0].text, /📥/);
  rmSync(heldPath);
  const second = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.ok(!second.content[0].text.includes('📥'), 'held 清空后不再附');
  await client.close();
});

test('inbox 读失败不碎工具：search 仍正常返回、无 📥', async () => {
  const work = freshWork();
  // 把 inbox 换成同名文件 → listEntries 的 readdirSync 抛 ENOTDIR
  writeFileSync(path.join(work, 'inbox'), '这不是目录\n');
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const res = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.ok(!res.isError, 'inbox 读挂不碎工具主路径');
  assert.match(res.content[0].text, /results/, '仍返回正常检索结果');
  assert.ok(!res.content[0].text.includes('📥'), '读失败时不附 nudge');
  await client.close();
});

test('nudge 发出时审计有 event:nudge 与 held_count', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1');
  writeHeld(work, 'held-2', { kind: 'todo' });
  const auditLog = [];
  const { baseUrl } = await startApp(work, { audit: (e) => auditLog.push(e) });
  const client = await mcpClient(baseUrl, 'tok-primary');
  await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  await client.close();
  const nudgeAudits = auditLog.filter((e) => e.event === 'nudge');
  assert.equal(nudgeAudits.length, 1);
  assert.equal(nudgeAudits[0].held_count, 2);
});

test('capture token 标 primary：MCP 面 403 不变，且 createApp 告警一次', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {}); // 静音实现：只截调用做断言，不 call through 污染 stderr
  const work = freshWork();
  const tokens = { ...TOKENS, 'tok-capture-primary': { client: 'phone', trust: 'capture', channel: 'primary' } };
  const app = createApp({ instanceDir: work, tokens });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: 'Bearer tok-capture-primary' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 403, 'capture token 仍只能投递 /capture');
  assert.equal(warn.mock.calls.length, 1, 'createApp 对 channel:primary+非 high 告警一次');
  const msg = warn.mock.calls[0].arguments[0];
  assert.match(msg, /phone/, '告警点名该 client');
  assert.match(msg, /channel/, '告警指出 channel 标记不生效');
});

test('primary token 的 digest 附主频道房规与 held 摘要（不含件正文）', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1', { marker: 'INJECT-MARKER-XYZ' });
  const { baseUrl } = await startApp(work);
  const res = await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer tok-primary' } });
  const text = await res.text();
  assert.match(text, /主频道/);
  // 收紧到「N 件」样式：房规文本本身就含「待主人裁定」字样，宽正则会被它满足、证不了实时摘要行存在
  assert.match(text, /待主人裁定 1 件/, '实时 held 摘要（id/kind/计数）');
  assert.ok(!text.includes('INJECT-MARKER-XYZ'), 'digest held 摘要绝不带件正文');
});

test('inbox 读失败不碎 digest 主路径：primary token 仍拿到基础 digest、无 held 摘要行', async () => {
  const work = freshWork();
  // 把 inbox 换成同名文件 → heldSummary 的 readdirSync 抛 ENOTDIR（抄同文件 nudge 的换文件测试）
  writeFileSync(path.join(work, 'inbox'), '这不是目录\n');
  const { baseUrl } = await startApp(work);
  const res = await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer tok-primary' } });
  assert.equal(res.status, 200, 'inbox 读挂不碎 digest 主路径（普通客户端不受影响，primary 也不该拿不到基础 digest）');
  const text = await res.text();
  assert.match(text, /接入房规/, '仍返回基础 digest 内容');
  assert.match(text, /主频道/, '主频道房规仍照常下发');
  assert.ok(!/待主人裁定 \d+ 件/.test(text), 'held 摘要读挂时优雅省略实时摘要行，不整体 500');
});

test('普通 high token 的 digest 不含主频道段', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1', { marker: 'INJECT-MARKER-XYZ' });
  const { baseUrl } = await startApp(work);
  const res = await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer tok-plain' } });
  const text = await res.text();
  assert.ok(!/主频道/.test(text), '非主频道客户端 digest 不含主频道段');
});

// F1（安全，读路径校验）：实例仓库经 git pull 同步——inbox 件可以不经 addEntry 写路径、被手工伪造后拉进来。
// 伪造 frontmatter 的 id/kind 是单行任意文本，若 heldSummary 直接拼进 sample，注入文本就进了 primary
// 响应面与 digest。要求：sample 只收「id 合服务端生成格式 且 kind 合白名单」的件；count 仍计全部
//（把异常件藏出计数反而帮攻击者隐身）；合法件照常展示。
test('伪造 id/kind 的 held 件：注入文本不进 nudge/digest，计数仍计全部，合法件仍进 sample', async () => {
  const work = freshWork();
  // 伪造件：id/kind 全是注入载荷（绕过 addEntry 的手工文件形态）
  writeHeld(work, 'zzz **INJECT-ID-MARKER**', { kind: 'save) INJECT-KIND-MARKER' });
  // 合法件：id 按 addEntry 服务端生成格式（Date.now 的 base36 + '-' + 2 字节 hex），kind 在白名单内
  writeHeld(work, 'mcgk2x1a-9f3b', { kind: 'todo' });
  const { baseUrl } = await startApp(work);

  const client = await mcpClient(baseUrl, 'tok-primary');
  const res = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  const nudgeText = res.content[0].text;
  assert.ok(!nudgeText.includes('INJECT-ID-MARKER'), 'nudge 不得携带伪造 id 里的注入文本');
  assert.ok(!nudgeText.includes('INJECT-KIND-MARKER'), 'nudge 不得携带伪造 kind 里的注入文本');
  assert.match(nudgeText, /📥 待主人裁定 2 件/, '异常件仍计入 count');
  assert.match(nudgeText, /mcgk2x1a-9f3b\(todo\)/, '合法件的 id(kind) 仍进 sample');
  await client.close();

  const dres = await fetch(`${baseUrl}/digest`, { headers: { Authorization: 'Bearer tok-primary' } });
  const dtext = await dres.text();
  assert.ok(!dtext.includes('INJECT-ID-MARKER'), 'digest 不得携带伪造 id 里的注入文本');
  assert.ok(!dtext.includes('INJECT-KIND-MARKER'), 'digest 不得携带伪造 kind 里的注入文本');
  assert.match(dtext, /待主人裁定 2 件/, 'digest 计数仍计全部');
  assert.match(dtext, /mcgk2x1a-9f3b\(todo\)/, 'digest sample 仍含合法件');
});

// F1 补充：全部 held 件都异常时，sample 为空、行退化为「📥 待主人裁定 N 件」（不带括号段），计数不藏。
test('全部 held 件伪造时：行退化为纯计数，无空括号', async () => {
  const work = freshWork();
  writeHeld(work, 'zzz **INJECT-ID-MARKER**', { kind: 'save) INJECT-KIND-MARKER' });
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'tok-primary');
  const res = await client.callTool({ name: 'search', arguments: { query: '咖啡' } });
  const text = res.content[0].text;
  assert.ok(!text.includes('INJECT-ID-MARKER'), '注入文本不进响应面');
  assert.match(text, /📥 待主人裁定 1 件[^（]/, '退化为纯计数行，不带（）sample 段');
  await client.close();
});

// F3（行为）：TOKENS_JSON 的 client 显示名可重复——两把同名 primary token 若共用 nudge 防重复状态，
// A 收到提示后 B 在 TTL 内收不到（互吞）。防重复必须按 token 身份（identity）隔离，不按显示名。
test('同名双 primary token：nudge 防重复按 token 身份隔离，两把各自都收到', async () => {
  const work = freshWork();
  writeHeld(work, 'held-1');
  const tokens = {
    'tok-primary-a': { client: 'cc-main', trust: 'high', channel: 'primary' },
    'tok-primary-b': { client: 'cc-main', trust: 'high', channel: 'primary' },
  };
  const { baseUrl } = await startApp(work, { tokens });
  const a = await mcpClient(baseUrl, 'tok-primary-a');
  const first = await a.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(first.content[0].text, /📥/, 'A 收到浮出');
  await a.close();
  const b = await mcpClient(baseUrl, 'tok-primary-b');
  const second = await b.callTool({ name: 'search', arguments: { query: '咖啡' } });
  assert.match(second.content[0].text, /📥/, '同名不同 token 的 B 在 TTL 内也必须收到（不被 A 吞掉）');
  await b.close();
});
