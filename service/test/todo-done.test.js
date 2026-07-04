import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
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
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-tdone-'));
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

function run(work, decisionJson, { content = '换轮胎那条做完了' } = {}) {
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const calls = [];
  const keeper = createKeeper({
    instanceDir: work, writer,
    provider: { judge: async (req) => { calls.push(req); return { json: decisionJson, model: 'flash', usage: {} }; } },
    notifier: { notify: async () => ({ ok: true }) },
    doctor: false,
  });
  const receipt = inbox.addEntry({ kind: 'todo_done', content, client: 'cc-test' });
  return { keeper, receipt, calls };
}

test('todo_done：那条从待办挪进已完成（带 ✅ 日期），清单进 prompt', async () => {
  const { work } = makeInstance();
  const { keeper, receipt, calls } = run(work, {
    disposition: 'canonical', zone: 'todo', action: 'todo_done',
    target: '给自行车换轮胎', summary: '完成：给自行车换轮胎', confidence: 0.96,
  });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  const todo = readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8');
  assert.ok(!/^\d+\. 给自行车换轮胎$/m.test(todo), '待办里不应再有这条');
  assert.match(todo, /## 已完成\n+- 给自行车换轮胎 ✅ \d{4}-\d{2}-\d{2}/, '已完成小节应有这条（没有小节则自动建）');
  assert.match(todo, /读完《测试驱动开发》/, '其他条目不受影响');
  assert.match(calls[0].user, /给自行车换轮胎/, '当前待办清单应在判断材料里');
});

test('todo_done：匹配不到那条 → held 不乱动', async () => {
  const { work } = makeInstance();
  const { keeper, receipt } = run(work, {
    disposition: 'canonical', zone: 'todo', action: 'todo_done',
    target: '一条不存在的待办', summary: 's', confidence: 0.9,
  });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  const todo = readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8');
  assert.match(todo, /给自行车换轮胎/, '清单应原封不动');
});
