import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createEventStore } from '../src/events.js';
import { nativeToken } from '../src/inbox.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = {
  'cap-token': { client: 'app-ios', trust: 'capture' },
  'high-token': { client: 'cc-test', trust: 'high' },
};

let httpServer, baseUrl, work, eventStore, app;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-capture-'));
  const origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  eventStore = createEventStore({ file: path.join(base, 'events.jsonl') });
  app = createApp({ instanceDir: work, tokens: TOKENS, eventStore });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => httpServer?.close());

function post(pathname, token, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('POST /capture：设备 token 秒回受理，件带 url/text/note', async () => {
  const res = await post('/capture', 'cap-token', {
    url: 'https://example.com/article', text: '一篇讲手冲的文章', note: '想试这个方法',
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok && j.id && j.path.startsWith('inbox/'));
  const raw = readFileSync(path.join(work, j.path), 'utf8');
  assert.match(raw, /kind: capture/);
  assert.match(raw, /client: app-ios/);
  assert.match(raw, /admission_trust: capture/);
  assert.match(raw, /admission_source: static/);
  assert.match(raw, /admission_ingress: capture/);
  assert.match(raw, /admission_capabilities: \["collection:insert","page:create","todo:add"\]/);
  assert.match(raw, /hint: 想试这个方法/);
  assert.match(raw, /example\.com\/article/);
  assert.match(raw, /一篇讲手冲的文章/);
});

test('POST /capture：无 token 401；url/text 全缺 400；含密钥 400 拒收', async () => {
  assert.equal((await post('/capture', null, { text: 'x' })).status, 401);
  assert.equal((await post('/capture', 'cap-token', { note: '只有备注' })).status, 400);
  const res = await post('/capture', 'cap-token', { text: 'key 是 ghp_abcdefghij1234567890abcd' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /拒收/);
});

test('capture token 不能碰 /mcp（403）', async () => {
  const res = await post('/mcp', 'cap-token', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.status, 403);
});

test('GET /capture/status：App 是收件审阅界面——capture 与高信任全见（含全文），并带 content', async () => {
  eventStore.push({ id: 'e1', client: 'app-ios', verdict: 'filed', detail: 'knowledge/x.md', summary: '已存', ts: 't1' });
  eventStore.push({ id: 'e2', client: 'cc-test', verdict: 'held', detail: '', summary: '待定夺', ts: 't2' });
  const mine = await (await fetch(`${baseUrl}/capture/status`, { headers: { Authorization: 'Bearer cap-token' } })).json();
  assert.ok(mine.pending.length >= 1, 'capture token 应看到全部待处理件（含其他客户端投的）');
  assert.ok(mine.pending.every((p) => typeof p.content === 'string' && p.content.length > 0), '带全文供审阅');
  assert.deepEqual(mine.events.map((e) => e.id).sort(), ['e1', 'e2'], 'capture token 全见事件（心脏界面）');
  const all = await (await fetch(`${baseUrl}/capture/status`, { headers: { Authorization: 'Bearer high-token' } })).json();
  assert.deepEqual(all.events.map((e) => e.id).sort(), ['e1', 'e2']);
});

test('POST /capture/resolve：App 可裁定任意收件，落 owner_ruling + 通道标记', async () => {
  const posted = await (await post('/capture', 'cap-token', { text: '待裁定的一条' })).json();
  const res = await post('/capture/resolve', 'cap-token', { id: posted.id, ruling: '这条进待办' });
  assert.equal(res.status, 200);
  const raw = readFileSync(path.join(work, posted.path), 'utf8');
  assert.match(raw, /owner_ruling: 这条进待办/);
  assert.match(raw, /ruling_via: app-ios/);
  assert.match(raw, /ruling_via_trust: capture/);
  assert.equal((await post('/capture/resolve', 'cap-token', { id: 'nope', ruling: 'x' })).status, 400);
  assert.equal((await post('/capture/resolve', null, { id: posted.id, ruling: 'x' })).status, 401);
});

test('POST /capture/resolve：点选候选（option 参数）→ 预批决定落盘', async () => {
  const posted = await (await post('/capture', 'cap-token', { text: '点选裁定的一条' })).json();
  const fs = await import('node:fs');
  const abs = path.join(work, posted.path);
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + `\n<!--keeper-options\n${JSON.stringify({ options: [
    { label: '进待办', decision: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: 's', confidence: 0.9 } },
  ] })}\n-->\n`);
  // SEC-5 二/三轮：capture 件经 /capture 亲生（内容绑定已登记，无 options）。本测试无 keeper，故手工塞 options 模拟
  // keeper.holdEntry——须同款刷新亲生绑定（把新 options 纳入），否则内容绑定 gate 会把这份合法候选当篡改挡下。
  app.locals.nativeReg.set(posted.id, nativeToken({ id: posted.id, rel: posted.path, kind: 'capture', client: 'app-ios', raw: fs.readFileSync(abs, 'utf8') }));
  const res = await post('/capture/resolve', 'cap-token', { id: posted.id, option: 0 });
  assert.equal(res.status, 200, `应 200，实际 ${res.status}: ${JSON.stringify(await res.json().catch(() => ''))}`);
  const after = fs.readFileSync(abs, 'utf8');
  assert.match(after, /owner_ruling: 进待办/);
  assert.match(after, /<!--owner-decision/);
});

test('eventStore：重启后从文件恢复', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'substrate-ev-')), 'ev.jsonl');
  const s1 = createEventStore({ file });
  s1.push({ id: 'a', client: 'c', verdict: 'filed', ts: 't' });
  const s2 = createEventStore({ file });
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].id, 'a');
});

// ==================== D2（M4.6）：裁定面按通道收窄（服务端强制）====================
// 直接往 work/inbox 写一个 maintenance/schema 件（模拟遗留/结构提案）。放最后跑，不扰前面按序的用例。
async function seedInboxFile(id, kind) {
  const fs = await import('node:fs');
  const dir = path.join(work, 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const rel = `inbox/_2026-01-01-${id}.md`;
  fs.writeFileSync(path.join(work, rel), [
    '---', `title: 收件 ${id}`, 'created: 2026-01-01', 'updated: 2026-01-01', 'type: inbox',
    `id: ${id}`, 'received_at: 2026-01-01T00:00:00.000Z', 'client: nightly', `kind: ${kind}`,
    'keeper_held_at: 2026-01-01T00:00:00.000Z', 'status: held', '---', '', '一条治理提案正文\n',
  ].join('\n'));
  return { id, rel };
}
const statusJson = (token) =>
  fetch(`${baseUrl}/capture/status`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

test('D2 /capture/status：capture 通道不列 maintenance/schema（无权兑现的件不出现在待定夺列表）；高信任全见', async () => {
  const mnt = await seedInboxFile('mnt00001-aa11', 'maintenance');
  const sch = await seedInboxFile('sch00001-bb22', 'schema');
  const cap = await statusJson('cap-token');
  assert.ok(!cap.pending.some((p) => p.id === mnt.id), 'capture 不列 maintenance 件');
  assert.ok(!cap.pending.some((p) => p.id === sch.id), 'capture 不列 schema 件');
  // 但普通 capture/save 件照常可见（不误伤）
  const posted = await (await post('/capture', 'cap-token', { text: 'D2 普通件仍可见' })).json();
  assert.ok((await statusJson('cap-token')).pending.some((p) => p.id === posted.id), 'capture 件照常在列');
  // 高信任 CC/Hermes 全见（它们有权裁这类件）
  const hi = await statusJson('high-token');
  assert.ok(hi.pending.some((p) => p.id === mnt.id), '高信任仍见 maintenance 件');
  assert.ok(hi.pending.some((p) => p.id === sch.id), '高信任仍见 schema 件');
});

test('D2（Finding4 kind 归一）大小写/空白变体的 maintenance 件同样被 D2 挡住——展示面与执行面不再因变体失配', async () => {
  // 伪造件 git pull 进来时 frontmatter 的 kind 是任意文本：`Maintenance`（大写）、` maintenance `（首尾空白）。
  // 归一前它们绕过 CAPTURE_UNRULABLE_KINDS.has('maintenance') → 泄进 App 待定夺列表（无权兑现的按钮）。
  const up = await seedInboxFile('mntup001-aa11', 'Maintenance');
  const sp = await seedInboxFile('mntsp001-bb22', '  maintenance  ');
  const cap = await statusJson('cap-token');
  assert.ok(!cap.pending.some((p) => p.id === up.id), '大写 Maintenance 变体件不列（归一后被 D2 挡）');
  assert.ok(!cap.pending.some((p) => p.id === sp.id), '带空白 maintenance 变体件不列');
  // 入口裁定同样 403（listEntries 归一后 hit.kind 命中 CAPTURE_UNRULABLE_KINDS）
  const res = await post('/capture/resolve', 'cap-token', { id: up.id, ruling: '批准' });
  assert.equal(res.status, 403, '大写变体件裁定入口即 403');
  assert.ok(!/owner_ruling:/.test(readFileSync(path.join(work, up.rel), 'utf8')), '未落 owner_ruling');
});

test('D2 /capture/resolve：capture 通道裁 maintenance/schema 在入口即 403（不再走到 keeper 才弹回）', async () => {
  const mnt = await seedInboxFile('mnt00002-cc33', 'maintenance');
  const res = await post('/capture/resolve', 'cap-token', { id: mnt.id, ruling: '批准删除' });
  assert.equal(res.status, 403, '入口处拒（403），不落 owner_ruling');
  assert.match((await res.json()).error, /不经手机裁定/);
  // 入口拒 = 件未被改写（没有 owner_ruling 落盘 → 主人不会「判了→不算→重来」）
  const raw = readFileSync(path.join(work, mnt.rel), 'utf8');
  assert.ok(!/owner_ruling:/.test(raw), 'maintenance 件未落 owner_ruling（入口拦下，未触达 resolveEntry）');
  // schema 件同样入口拒
  const sch = await seedInboxFile('sch00002-dd44', 'schema');
  assert.equal((await post('/capture/resolve', 'cap-token', { id: sch.id, ruling: '建' })).status, 403);
  // 高信任仍可裁 maintenance（它有权兑现）→ 200，落 owner_ruling
  const okRes = await post('/capture/resolve', 'high-token', { id: mnt.id, ruling: '这条我来处理' });
  assert.equal(okRes.status, 200, '高信任裁 maintenance 放行');
  assert.match(readFileSync(path.join(work, mnt.rel), 'utf8'), /owner_ruling: 这条我来处理/);
});
