import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-resolve-'));
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

test('listEntries：返回 inbox 全部件与状态', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const a = inbox.addEntry({ kind: 'save', content: '第一条', client: 'cc-test' });
  const b = inbox.addEntry({ kind: 'todo', content: '第二条', client: 'cc-test' });
  await Promise.all([a.synced, b.synced]);
  const { entries } = inbox.listEntries();
  assert.equal(entries.length, 2);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.ok(entries.every((e) => e.status === 'pending'));
  assert.ok(entries.every((e) => e.excerpt.length > 0));
});

test('resolveEntry：写入主人裁定并复位 pending；未知 id 报可读错误', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const r = inbox.addEntry({ kind: 'save', content: '拿不准的内容', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这条进 todo' });
  await resolved.synced;
  const raw = readFileSync(path.join(work, r.path), 'utf8');
  assert.match(raw, /status: pending/);
  assert.match(raw, /owner_ruling: 这条进 todo/);
  assert.throws(() => inbox.resolveEntry({ id: 'nope', ruling: 'x' }), /找不到|nope/);
});

test('keeper：主人裁定进 prompt、按裁定执行、判例自动落 _cases.md', async () => {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const calls = [];
  const provider = {
    judge: async (req) => {
      calls.push(req);
      return {
        json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '按裁定进待办', confidence: 0.99 },
        model: 'flash', usage: {},
      };
    },
  };
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'save', content: '给猫买磨爪板', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这是待办不是知识，进 todo' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.match(calls[0].user, /主人裁定.*进 todo/s, '裁定应进判断材料');
  assert.match(readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /给猫买磨爪板/);
  const cases = readFileSync(path.join(work, 'keeper-feedback', '_cases.md'), 'utf8');
  assert.match(cases, new RegExp(r.id));
  assert.match(cases, /这是待办不是知识/);
  assert.match(git(origin, 'log', '--oneline', '-2'), /keeper/);
});
