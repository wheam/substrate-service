// M4.4 Task 2：schema 演化——propose / 点选批准 / apply + doctor 回滚。
// 三组：A propose 工具；B apply 工具 + doctor 回滚；C 点选通路（keeper SKIP_LLM）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { parseZones } from '../src/acl.js';
import { runDoctor, validateSchemaProposal } from '../src/executor.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

const TOKENS = {
  'w-high':    { client: 'cc-test', trust: 'high' },
  'w-primary': { client: 'cc-main', trust: 'high', channel: 'primary' },
  'w-low':     { client: 'app-low', trust: 'low' },
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

// git 后端实例（addEntry/resolve/keeper 都 commitAndPush，需真远端）；各用例独立 origin，push 不互染。
function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-schema-'));
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

const servers = [];
after(() => { for (const s of servers) s.close(); });

async function startApp(work, opts = {}) {
  const app = createApp({ instanceDir: work, tokens: TOKENS, ...opts });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
}

async function mcpClient(baseUrl, token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

function readSchemaEntry(work) {
  const dir = path.join(work, 'inbox');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => n.startsWith('_') && n.endsWith('.md')
    && /^kind: schema$/m.test(readFileSync(path.join(dir, n), 'utf8')));
  return f ? readFileSync(path.join(dir, f), 'utf8') : null;
}

function schemaEntryId(work) {
  return readSchemaEntry(work)?.match(/^id: (.+)$/m)?.[1]?.trim() ?? null;
}

// 令 doctor stub 恒报 1 error（测回滚）——直接改写 work 实例里的 doctor.py 输出。
function makeDoctorFail(work) {
  writeFileSync(path.join(work, 'skills', 'substrate-doctor', 'doctor.py'), 'print("→ 1 error(s)")\n');
}

// ==================== 组 A：schema_propose 工具 ====================

test('A1 合法 propose：落 held 件带 keeper_held_at + json 块 + 候选块；回执提示浮出', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  const r = await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康与运动记录' } });
  assert.notEqual(r.isError, true, `propose 不应报错：${r.content?.[0]?.text}`);
  assert.match(r.content[0].text, /浮出|待批/, '回执应提示主频道会浮出待批');
  const raw = readSchemaEntry(work);
  assert.ok(raw, '应落一件 kind:schema');
  assert.match(raw, /status: held/, '提案件创建即 held');
  assert.match(raw, /keeper_held_at: \d{4}-\d{2}-\d{2}T/, 'held 件带 keeper_held_at 机器标记');
  assert.match(raw, /```json[\s\S]*"id": "health"[\s\S]*"path": "health\/"[\s\S]*```/, '正文含提案全量 json 块');
  assert.match(raw, /<!--keeper-options\n[\s\S]*建这个 zone[\s\S]*扔掉[\s\S]*-->/, '带 2 个点选候选');
  await client.close();
});

test('A2 冲突/非法形状被拒（工具 isError）', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  // id 与现有 zone 冲突
  const dupId = await client.callTool({ name: 'schema_propose', arguments: { id: 'todo', path: 'newtodo/', purpose: 'x' } });
  assert.equal(dupId.isError, true, 'id 冲突应被拒');
  // path 与现有 zone 冲突
  const dupPath = await client.callTool({ name: 'schema_propose', arguments: { id: 'fresh', path: 'todo/', purpose: 'x' } });
  assert.equal(dupPath.isError, true, 'path 冲突应被拒');
  // 非法 path 形状（多级目录）
  const badPath = await client.callTool({ name: 'schema_propose', arguments: { id: 'fresh', path: 'a/b/', purpose: 'x' } });
  assert.equal(badPath.isError, true, '多级 path 应被拒');
  // 冲突/非法都不该落件
  assert.equal(readSchemaEntry(work), null, '被拒的 propose 不落件');
  await client.close();
});

test('A3 低信任客户端无 schema_propose / schema_apply 工具', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const low = await mcpClient(baseUrl, 'w-low');
  const names = (await low.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes('schema_propose'), '低信任不该见 schema_propose');
  assert.ok(!names.includes('schema_apply'), '低信任不该见 schema_apply');
  await low.close();
  const high = await mcpClient(baseUrl, 'w-high');
  const hnames = (await high.listTools()).tools.map((t) => t.name);
  assert.ok(hnames.includes('schema_propose') && hnames.includes('schema_apply'), '高信任应见两工具');
  await high.close();
});

test('A4 nudge 浮出包含该 schema 提案件（复用主频道浮出）', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  // 先由高信任提案落 held 件
  const proposer = await mcpClient(baseUrl, 'w-high');
  await proposer.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  await proposer.close();
  // 主频道客户端下一次工具响应尾部应浮出该 held 件（kind schema 在白名单 → 进 sample）
  const primary = await mcpClient(baseUrl, 'w-primary');
  const res = await primary.callTool({ name: 'search', arguments: { query: '咖啡' } });
  const text = res.content[0].text;
  assert.match(text, /📥 待主人裁定 1 件/, '主频道浮出该提案件');
  assert.match(text, /\(schema\)/, 'sample 含 schema kind');
  await primary.close();
});

// ==================== 组 B：schema_apply 工具通路 + doctor 回滚 ====================

test('B1 apply：zones.md 多一条（parseZones 读得到）、目录+README 存在、提案件消失、audit event:schema_apply', async () => {
  const { work } = makeInstance();
  const auditLog = [];
  const { baseUrl } = await startApp(work, { audit: (e) => auditLog.push(e) });
  const client = await mcpClient(baseUrl, 'w-high');
  await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康与运动记录', privacy: 'sensitive' } });
  const eid = schemaEntryId(work);
  assert.ok(eid, '应有 schema 提案件 id');
  const r = await client.callTool({ name: 'schema_apply', arguments: { id: eid } });
  assert.notEqual(r.isError, true, `apply 不应报错：${r.content?.[0]?.text}`);
  // zones.md 多一条且能被 parseZones 读回
  const zones = parseZones(work);
  const z = zones.find((x) => x.id === 'health');
  assert.ok(z, 'parseZones 应读到新 zone');
  assert.equal(z.path, 'health/');
  assert.equal(z.privacy, 'sensitive', '落盘保留 propose 的 privacy');
  assert.equal(z.maintainer_skill, 'substrate-curator');
  // 目录 + README + .gitkeep 存在
  assert.ok(existsSync(path.join(work, 'health', 'README.md')), 'README stub 存在');
  assert.ok(existsSync(path.join(work, 'health', '.gitkeep')), '.gitkeep 存在');
  assert.match(readFileSync(path.join(work, 'health', 'README.md'), 'utf8'), /# health[\s\S]*健康与运动记录/);
  // 提案件消失
  assert.equal(readSchemaEntry(work), null, '落地后提案件应移除');
  // audit 有 event:schema_apply
  assert.ok(auditLog.some((e) => e.event === 'schema_apply' && e.zone_id === 'health'), 'audit 记 event:schema_apply');
  await client.close();
});

test('B2 doctor 报 error → zones.md 回滚原样、目录不存在、工具报错含「回滚」、提案件仍在', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  const eid = schemaEntryId(work);
  const zonesBefore = readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8');
  makeDoctorFail(work); // doctor 恒报 1 error
  const r = await client.callTool({ name: 'schema_apply', arguments: { id: eid } });
  assert.equal(r.isError, true, 'doctor 报错时 apply 应失败');
  assert.match(r.content[0].text, /回滚/, '报错含「回滚」');
  // zones.md 逐字回滚原样、无 health
  assert.equal(readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8'), zonesBefore, 'zones.md 逐字回滚');
  assert.ok(!parseZones(work).some((z) => z.id === 'health'), 'zones 不含 health');
  // 新建目录被删
  assert.ok(!existsSync(path.join(work, 'health')), '回滚删掉新建目录');
  // 提案件仍在（未清场）
  assert.ok(readSchemaEntry(work), '回滚后提案件仍在 inbox');
  await client.close();
});

test('B2b doctor 无可解析结果 → schema_apply fail closed、回滚且不提交', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  const eid = schemaEntryId(work);
  const zonesBefore = readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8');
  writeFileSync(
    path.join(work, 'skills', 'substrate-doctor', 'doctor.py'),
    'print("doctor output format changed")\n',
  );

  const r = await client.callTool({ name: 'schema_apply', arguments: { id: eid } });
  assert.equal(r.isError, true, 'doctor 无结果时 apply 应安全失败');
  assert.match(r.content[0].text, /doctor 未返回可解析结果.*回滚/, '报错应说明 fail-closed 回滚');
  assert.equal(readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8'), zonesBefore, 'zones.md 逐字回滚');
  assert.ok(!existsSync(path.join(work, 'health')), '不得残留新 zone 目录');
  assert.ok(readSchemaEntry(work), '提案件仍应留在 inbox');
  assert.doesNotMatch(
    git(work, 'ls-tree', '-r', '--name-only', 'origin/main'),
    /^health\//m,
    '远端 main 不得出现 doctor 无结果时的新 zone',
  );
  await client.close();
});

test('B3 对 kind≠schema 的件 apply 被拒', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  const saved = await client.callTool({ name: 'save', arguments: { content: '一段普通内容' } });
  const savedId = saved.content[0].text.match(/inbox\/_[\d-]+-([\w-]+)\.md/)?.[1];
  assert.ok(savedId, '应拿到 save 件 id');
  const r = await client.callTool({ name: 'schema_apply', arguments: { id: savedId } });
  assert.equal(r.isError, true, 'kind≠schema 应被拒');
  assert.match(r.content[0].text, /不是 schema/, '报错点明不是 schema 件');
  await client.close();
});

// ==================== 组 C：点选通路（keeper SKIP_LLM，绝不调 provider）====================

// 会 throw 的 provider：一旦被调用即失败——证明 schema/maintenance 件走 SKIP_LLM、绝不进 judge/generateOptions。
function throwingProvider() {
  const calls = [];
  return { calls, judge: async (req) => { calls.push(req); throw new Error('SKIP_LLM 违反：provider 被调用了'); } };
}

// 直接落一个 schema 提案件（形状与 server.schemaPropose 一致），供 keeper 通路测试。
function proposeViaInbox(inbox, { id, path: zpath, purpose, privacy = 'private' }) {
  const proposal = { id, path: zpath, purpose, privacy };
  const content = `提议新建 zone「${id}」（${zpath}）：${purpose}\n\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\`\n`;
  const optionsBlock = { options: [
    { label: '✅ 建这个 zone', decision: { action: 'schema_apply', zone: 'governance', disposition: 'canonical', target: id, summary: `建 zone ${id}`, confidence: 1 } },
    { label: '扔掉别建', decision: { disposition: 'forbidden', reject_reason: '主人不要这个 zone' } },
  ] };
  return inbox.addEntry({ kind: 'schema', content, client: 'cc-test', status: 'held', optionsBlock });
}

function keeperSetup(work) {
  const writer = createWriter({ instanceDir: work });
  // F1：inbox 与 keeper 共享同一批准登记表（生产 createApp 同款接线）——resolveEntry 记账、keeper 核验。
  const approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals });
  const provider = throwingProvider();
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider, approvals,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  return { writer, inbox, provider, keeper, messages };
}

test('C1 点选「建」(option:0) → zone 落地、件清场；provider 从未被调用（SKIP_LLM）', async () => {
  const { work } = makeInstance();
  const { inbox, provider, keeper } = keeperSetup(work);
  const r = proposeViaInbox(inbox, { id: 'health', path: 'health/', purpose: '健康记录' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, '应落地为 filed');
  assert.equal(provider.calls.length, 0, 'SKIP_LLM：provider 绝不被调用');
  assert.ok(parseZones(work).some((z) => z.id === 'health'), 'zone 落地 zones.md');
  assert.ok(existsSync(path.join(work, 'health', 'README.md')), 'zone 目录+README 建好');
  assert.ok(!existsSync(path.join(work, r.path)), '落地后提案件清场');
});

test('C2 点选「扔掉」(option:1) → 件清场、无 zone；provider 从未被调用', async () => {
  const { work } = makeInstance();
  const { inbox, provider, keeper } = keeperSetup(work);
  const r = proposeViaInbox(inbox, { id: 'health', path: 'health/', purpose: '健康记录' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, option: 1, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.rejected, 1, '扔掉走 forbidden → rejected');
  assert.equal(provider.calls.length, 0, 'SKIP_LLM：provider 绝不被调用');
  assert.ok(!parseZones(work).some((z) => z.id === 'health'), '无 zone 落地');
  assert.ok(!existsSync(path.join(work, 'health')), '无 zone 目录');
  assert.ok(!existsSync(path.join(work, r.path)), '主人裁定的扔掉 → 件清场');
});

test('C3 纯文字 ruling（不点选）→ re-held 带注记、绝无执行、provider 从未被调用', async () => {
  const { work } = makeInstance();
  const { inbox, provider, keeper } = keeperSetup(work);
  const r = proposeViaInbox(inbox, { id: 'health', path: 'health/', purpose: '健康记录' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '你看着办给我建一个吧' }); // 纯文字、无 option
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1, '纯文字裁定 → re-held');
  assert.equal(provider.calls.length, 0, 'SKIP_LLM：绝不进 judge/generateOptions');
  const raw = readFileSync(path.join(work, r.path), 'utf8');
  assert.match(raw, /status: held/, '件复位 held');
  assert.match(raw, /请点选候选|点选/, '带注记提示点选候选');
  assert.ok(!parseZones(work).some((z) => z.id === 'health'), '纯文字裁定绝不触发执行（无 zone）');
  assert.ok(!existsSync(path.join(work, 'health')), '纯文字裁定绝不建目录');
});

// ==================== 组 D：review 加固（F1 围栏截断 / F2 骨架与回滚守卫 / F3 keeper 边路）====================

// 直接手写一件 kind:schema 的提案件（绕过 propose 的校验，模拟经 git pull 混进来的伪造件）。
function forgeSchemaEntry(work, payload, suffix) {
  const id = `${Date.now().toString(36)}-${suffix}`;
  const day = new Date().toISOString().slice(0, 10);
  const fm = [
    '---', `title: 收件 ${id}`, `created: ${day}`, `updated: ${day}`, 'type: inbox',
    `id: ${id}`, `received_at: ${new Date().toISOString()}`, 'client: forged', 'kind: schema',
    `keeper_held_at: ${new Date().toISOString()}`, 'status: held', '---', '',
  ].join('\n');
  const body = `伪造提案\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  mkdirSync(path.join(work, 'inbox'), { recursive: true });
  writeFileSync(path.join(work, 'inbox', `_${day}-${id}.md`), fm + body);
  return id;
}

// 递归快照一棵目录树（相对路径排序列表），断言「树完好」用
function treeSnapshot(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}${name.name}`;
      out.push(rel);
      if (name.isDirectory()) walk(path.join(d, name.name), `${rel}/`);
    }
  };
  walk(dir, '');
  return out;
}

test('D1(F1) purpose 含 ``` 不得截断 yaml 围栏：apply 后 parseZones 仍读回全部 zone、后续 sensitive zone 的 privacy 保留', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  // 第一发：purpose 带 ```（当前代码会原样落进 zones.md 的 purpose 行、提前闭合围栏）
  const r1 = await client.callTool({ name: 'schema_propose', arguments: { id: 'notes', path: 'notes/', purpose: '随手记 ``` 注入试探' } });
  assert.notEqual(r1.isError, true, `propose 不应报错：${r1.content?.[0]?.text}`);
  const eid1 = schemaEntryId(work);
  const a1 = await client.callTool({ name: 'schema_apply', arguments: { id: eid1 } });
  assert.notEqual(a1.isError, true, `apply#1 不应报错：${a1.content?.[0]?.text}`);
  // 第二发：sensitive zone——若围栏已被截断，它会落在 parseZones 视野之外 → ACL 静默绕过
  const r2 = await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录', privacy: 'sensitive' } });
  assert.notEqual(r2.isError, true, `propose#2 不应报错：${r2.content?.[0]?.text}`);
  const eid2 = schemaEntryId(work);
  const a2 = await client.callTool({ name: 'schema_apply', arguments: { id: eid2 } });
  assert.notEqual(a2.isError, true, `apply#2 不应报错：${a2.content?.[0]?.text}`);
  // 核心断言：全部 zone 可读回（4 个 fixture 原生 + notes + health），sensitive 保留
  const zones = parseZones(work);
  for (const id of ['todo', 'knowledge', 'collections', 'memory', 'notes', 'health']) {
    assert.ok(zones.some((z) => z.id === id), `parseZones 应读到 zone「${id}」（围栏不可被截断）`);
  }
  const health = zones.find((z) => z.id === 'health');
  assert.equal(health.privacy, 'sensitive', 'sensitive privacy 不得因围栏截断丢失');
  const notes = zones.find((z) => z.id === 'notes');
  assert.ok(!notes.purpose.includes('`'), `purpose 里的反引号应被清洗：${notes.purpose}`);
  // 长度上限：purpose 灌注记被截到 200 字符内（单元级直验共用校验函数）
  const v = validateSchemaProposal({ instanceDir: work, payload: { id: 'longp', path: 'longp/', purpose: 'x'.repeat(500) } });
  assert.ok(v.ok && v.purpose.length <= 200, `purpose 应有长度上限（实际 ${v.purpose?.length}）`);
  await client.close();
});

test('D2(F1) doctor stub 对「围栏截断」损坏报 error ≥1（验收门不再失明）', async () => {
  const { work } = makeInstance();
  // 直接把截断损坏写进 zones.md：purpose 行注入 mid-line ```（与 F1 攻击落盘后的形状一致）
  const zonesAbs = path.join(work, 'governance', 'zones.md');
  const raw = readFileSync(zonesAbs, 'utf8');
  writeFileSync(zonesAbs, raw.replace('purpose: 待办清单', 'purpose: 待办 ``` 清单'));
  const errors = await runDoctor(work, { enabled: true });
  assert.ok(typeof errors === 'number' && errors >= 1, `doctor 应报出围栏截断（实际 ${errors}）`);
});

test('D3(F2) propose path 指向骨架目录（governance/skills/inbox/keeper-feedback）一律拒', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  for (const zpath of ['skills/', 'governance/', 'inbox/', 'keeper-feedback/']) {
    const r = await client.callTool({ name: 'schema_propose', arguments: { id: 'sneaky', path: zpath, purpose: 'x' } });
    assert.equal(r.isError, true, `path=${zpath} 应被拒`);
    assert.match(r.content[0].text, /骨架/, `拒因应点名骨架区（path=${zpath}）`);
  }
  assert.equal(readSchemaEntry(work), null, '被拒的 propose 不落件');
  await client.close();
});

test('D4(F2) 伪造件绕 propose：骨架 path 与「目标目录已存在」都在 apply 拒、不动任何文件', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  const zonesBefore = readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8');
  // ① 伪造件 path=skills/（骨架区）：apply 拒，skills/ 原样（不被注册成 zone、不长出 README/.gitkeep）
  const skillsBefore = treeSnapshot(path.join(work, 'skills'));
  const fid1 = forgeSchemaEntry(work, { id: 'myskills', path: 'skills/', purpose: 'x', privacy: 'private' }, 'beef');
  const a1 = await client.callTool({ name: 'schema_apply', arguments: { id: fid1 } });
  assert.equal(a1.isError, true, '骨架 path 的伪造件应在 apply 被拒');
  assert.match(a1.content[0].text, /骨架/, '拒因点名骨架区');
  assert.deepEqual(treeSnapshot(path.join(work, 'skills')), skillsBefore, 'skills/ 树原样');
  assert.ok(!existsSync(path.join(work, 'skills', 'README.md')), '不得覆写/新建 skills/README.md');
  // ② 伪造件 payload 合法但目标目录已存在（防未来解注册目录被覆写+回滚误删）：apply 拒、目录内容原样
  mkdirSync(path.join(work, 'stash'));
  writeFileSync(path.join(work, 'stash', 'keep.txt'), '既有内容\n');
  const fid2 = forgeSchemaEntry(work, { id: 'stash', path: 'stash/', purpose: 'x', privacy: 'private' }, 'cafe');
  const a2 = await client.callTool({ name: 'schema_apply', arguments: { id: fid2 } });
  assert.equal(a2.isError, true, '目标目录已存在应在 apply 被拒');
  assert.match(a2.content[0].text, /已存在/, '拒因点明目录已存在');
  assert.equal(readFileSync(path.join(work, 'stash', 'keep.txt'), 'utf8'), '既有内容\n', '既有文件原样');
  assert.ok(!existsSync(path.join(work, 'stash', 'README.md')), '不得往既有目录写 README stub');
  // 两次被拒都不得动 zones.md
  assert.equal(readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8'), zonesBefore, 'zones.md 原样');
  assert.ok(!parseZones(work).some((z) => z.id === 'myskills' || z.id === 'stash'), '不得注册任何新 zone');
  await client.close();
});

test('D5(F2) doctor-fail 回滚只删本次新建：新目录消失、zones.md 原样、既有 skills/ 树完好', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-high');
  await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  const eid = schemaEntryId(work);
  const zonesBefore = readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8');
  makeDoctorFail(work); // doctor 恒报 1 error（改写 doctor.py 本身）
  const skillsBefore = treeSnapshot(path.join(work, 'skills')); // 快照取在 makeDoctorFail 之后
  const curateBefore = readFileSync(path.join(work, 'skills', 'substrate-curator', 'curate.py'), 'utf8');
  const r = await client.callTool({ name: 'schema_apply', arguments: { id: eid } });
  assert.equal(r.isError, true, 'doctor 报错时 apply 应失败');
  assert.match(r.content[0].text, /回滚/);
  assert.ok(!existsSync(path.join(work, 'health')), '本次新建目录被回滚删除');
  assert.equal(readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8'), zonesBefore, 'zones.md 逐字原样');
  assert.deepEqual(treeSnapshot(path.join(work, 'skills')), skillsBefore, '既有 skills/ 树完好（回滚绝不越界删）');
  assert.equal(readFileSync(path.join(work, 'skills', 'substrate-curator', 'curate.py'), 'utf8'), curateBefore, 'vendored 脚本内容完好');
  await client.close();
});

// ==================== 组 E：全 MCP 工具面回归（验收实测抓获的缺口）====================
// M4.4 的点选预批设计要求主频道 agent 在对话里经 MCP 工具 inbox_resolve 传 option 批准提案件。
// 此前 MCP inputSchema 只有 {id, ruling}——option 被 zod 剥掉，件复位成纯文字裁定 → keeper
// re-held（proposal-needs-option）→ 永远批不动。组 C 的端到端是进程内直调 resolveEntry({option})，
// 盖不住工具面；本组 propose→list→resolve 全走 MCP client，一步不落。

test('E1 全 MCP 面：schema_propose → inbox_list → inbox_resolve({id,ruling,option:0}) → keeper 零 LLM 落地 zone', async () => {
  const { work } = makeInstance();
  const { baseUrl, app } = await startApp(work);
  // keeper 复用 app.locals.writer（生产 index 入口同款接线）：MCP 写与 keeper 提交进同一单写者队列，git 不打架
  const provider = throwingProvider();
  const keeper = createKeeper({
    instanceDir: work, writer: app.locals.writer, provider, approvals: app.locals.approvals, // F1：与 app 内 inbox 共享登记表
    notifier: { notify: async () => ({ ok: true }) }, doctor: false,
  });
  const client = await mcpClient(baseUrl, 'w-primary'); // 主频道 agent 的真实工具面
  const p = await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  assert.notEqual(p.isError, true, `propose 不应报错：${p.content?.[0]?.text}`);
  // 主频道浮出后 agent 的第一步：inbox_list 拿 id 与候选（options[].index 即 option 取值）
  const listed = await client.callTool({ name: 'inbox_list', arguments: {} });
  const entry = JSON.parse(listed.content[0].text).entries.find((e) => e.kind === 'schema');
  assert.ok(entry, 'inbox_list 应见 schema 提案件');
  assert.equal(entry.options?.[0]?.index, 0, '候选块经 inbox_list 可见（index=0 为批准）');
  // 核心：经 MCP 工具面传 option 点选批准（修前 option 被剥 → 退化成纯文字裁定）
  const r = await client.callTool({ name: 'inbox_resolve', arguments: { id: entry.id, ruling: '批', option: 0 } });
  assert.notEqual(r.isError, true, `inbox_resolve 不应报错：${r.content?.[0]?.text}`);
  await client.close();
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, `MCP 点选批准应落地（修前：option 被剥 → re-held proposal-needs-option）：${JSON.stringify(result)}`);
  assert.equal(provider.calls.length, 0, 'SKIP_LLM：provider 绝不被调用');
  assert.ok(parseZones(work).some((z) => z.id === 'health'), 'zone 真落地 zones.md');
  assert.ok(existsSync(path.join(work, 'health', 'README.md')), 'zone 目录+README 建好');
  assert.equal(readSchemaEntry(work), null, '落地后提案件清场');
  // 受理回执回显点选候选的 label（option 真被收到），而非转述的 ruling 原话「批」
  assert.match(r.content[0].text, /建这个 zone/, `受理回执应回显候选 label：${r.content[0].text}`);
});

test('E2 全 MCP 面：inbox_resolve 传非法 option（越界）→ isError、件不复位', async () => {
  const { work } = makeInstance();
  const { baseUrl } = await startApp(work);
  const client = await mcpClient(baseUrl, 'w-primary');
  await client.callTool({ name: 'schema_propose', arguments: { id: 'health', path: 'health/', purpose: '健康记录' } });
  const eid = schemaEntryId(work);
  const r = await client.callTool({ name: 'inbox_resolve', arguments: { id: eid, ruling: '批', option: 9 } });
  assert.equal(r.isError, true, '越界 option 应 isError（resolveEntry throw → wrap 转 isError）');
  assert.match(r.content[0].text, /没有候选方案/, '报错点明没有该候选');
  assert.match(readSchemaEntry(work), /status: held/, '件保持 held、未被复位成 pending');
  await client.close();
});

test('D6(F3) keeper 点选通路遇 apply 抛错（doctor fail）→ 件 re-held 含失败原因、零 LLM、zones.md 原样', async () => {
  const { work } = makeInstance();
  const { inbox, provider, keeper } = keeperSetup(work);
  const r = proposeViaInbox(inbox, { id: 'health', path: 'health/', purpose: '健康记录' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const zonesBefore = readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8');
  makeDoctorFail(work); // applySchema 内的 doctor 必败 → 回滚 + throw
  git(work, 'add', 'skills/substrate-doctor/doctor.py');
  git(work, 'commit', '-m', 'test: make doctor fail');
  const result = await keeper.processPending();
  assert.equal(result.held, 1, 'apply 失败 → 件 re-held');
  assert.equal(provider.calls.length, 0, '失败边路也零 LLM（SKIP_LLM 不生成候选）');
  const raw = readFileSync(path.join(work, r.path), 'utf8');
  assert.match(raw, /status: held/, '件复位 held');
  assert.match(raw, /执行失败[\s\S]*回滚/, '注记含失败原因（doctor 回滚）');
  assert.equal(readFileSync(path.join(work, 'governance', 'zones.md'), 'utf8'), zonesBefore, 'zones.md 原样');
  assert.ok(!parseZones(work).some((z) => z.id === 'health'), '无 zone 落地');
  assert.ok(!existsSync(path.join(work, 'health')), '无残留目录');
});
