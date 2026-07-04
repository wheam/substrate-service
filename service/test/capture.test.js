import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createEventStore } from '../src/events.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = {
  'cap-token': { client: 'app-ios', trust: 'capture' },
  'high-token': { client: 'cc-test', trust: 'high' },
};

let httpServer, baseUrl, work, eventStore;

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
  const app = createApp({ instanceDir: work, tokens: TOKENS, eventStore });
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

test('GET /capture/status：设备 token 只见自己的件与事件，高信任全见', async () => {
  eventStore.push({ id: 'e1', client: 'app-ios', verdict: 'filed', detail: 'knowledge/x.md', summary: '已存', ts: 't1' });
  eventStore.push({ id: 'e2', client: 'cc-test', verdict: 'held', detail: '', summary: '待定夺', ts: 't2' });
  const mine = await (await fetch(`${baseUrl}/capture/status`, { headers: { Authorization: 'Bearer cap-token' } })).json();
  assert.ok(mine.pending.every((p) => p.client === 'app-ios'));
  assert.deepEqual(mine.events.map((e) => e.id), ['e1']);
  const all = await (await fetch(`${baseUrl}/capture/status`, { headers: { Authorization: 'Bearer high-token' } })).json();
  assert.deepEqual(all.events.map((e) => e.id).sort(), ['e1', 'e2']);
});

test('eventStore：重启后从文件恢复', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'substrate-ev-')), 'ev.jsonl');
  const s1 = createEventStore({ file });
  s1.push({ id: 'a', client: 'c', verdict: 'filed', ts: 't' });
  const s2 = createEventStore({ file });
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].id, 'a');
});
