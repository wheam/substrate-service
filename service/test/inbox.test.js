import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';

let origin, work, inbox;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-inbox-'));
  origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seedDir]);
  writeFileSync(path.join(seedDir, 'README.md'), 'seed\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  inbox = createInbox({ instanceDir: work, writer: createWriter({ instanceDir: work }) });
});

test('addEntry：秒回受理回执，文件落 inbox/ 且带完整 frontmatter', async () => {
  const receipt = inbox.addEntry({ kind: 'save', content: '今天决定用 DeepSeek 起步', hint: '决定', client: 'cc-test' });
  assert.ok(receipt.id);
  assert.match(receipt.path, /^inbox\//);
  assert.equal(receipt.status, 'pending');
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /^---\n/);
  assert.match(raw, new RegExp(`id: ${receipt.id}`));
  assert.match(raw, /kind: save/);
  assert.match(raw, /client: cc-test/);
  assert.match(raw, /status: pending/);
  assert.match(raw, /hint: 决定/);
  assert.match(raw, /今天决定用 DeepSeek 起步/);
  await receipt.synced; // 后台 commit+push 完成
  assert.match(git(origin, 'log', '--oneline', '-1'), new RegExp(receipt.id));
});

test('addEntry：collection 类携带 name 与结构化 row', async () => {
  const receipt = inbox.addEntry({
    kind: 'collection', client: 'cc-test',
    payload: { name: 'restaurants', row: { name: '测试餐厅', city: '样例城' } },
  });
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /kind: collection/);
  assert.match(raw, /collection: restaurants/);
  assert.match(raw, /测试餐厅/);
  await receipt.synced;
});

test('addEntry：内容含疑似密钥 → 拒收不落盘（红线扫描在写路径）', async () => {
  assert.throws(
    () => inbox.addEntry({ kind: 'save', content: '我的 key 是 sk-ant-api03-abcdefghij1234567890', client: 'cc-test' }),
    /疑似密钥|凭据/
  );
  const files = readdirSync(path.join(work, 'inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    assert.ok(!readFileSync(path.join(work, 'inbox', f), 'utf8').includes('sk-ant-api03'), '密钥不应落盘');
  }
});

test('addEntry：连发两条 id 不撞、都入 git', async () => {
  const a = inbox.addEntry({ kind: 'todo', content: '买牛奶', client: 'cc-test' });
  const b = inbox.addEntry({ kind: 'todo', content: '修灯', client: 'cc-test' });
  assert.notEqual(a.id, b.id);
  await Promise.all([a.synced, b.synced]);
  const log = git(origin, 'log', '--oneline', '-4');
  assert.match(log, new RegExp(a.id));
  assert.match(log, new RegExp(b.id));
});
