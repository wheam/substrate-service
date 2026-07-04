import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';

let origin, seed, work;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-writer-'));
  origin = path.join(base, 'origin.git');
  seed = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
});

test('commitAndPush：提交并推到远端', async () => {
  const writer = createWriter({ instanceDir: work });
  writeFileSync(path.join(work, 'a.md'), 'hello\n');
  const r = await writer.commitAndPush({ paths: ['a.md'], message: 'inbox: 收件 a' });
  assert.equal(r.ok, true);
  assert.match(git(origin, 'log', '--oneline', '-1'), /收件 a/);
});

test('commitAndPush：远端领先时 rebase 重试成功（撞车协议兜底）', async () => {
  // 模拟别的机器直写：远端先进一个提交
  writeFileSync(path.join(seed, 'other.md'), 'other\n');
  git(seed, 'pull', '--rebase');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'direct write elsewhere');
  git(seed, 'push');

  const writer = createWriter({ instanceDir: work });
  writeFileSync(path.join(work, 'b.md'), 'mine\n');
  const r = await writer.commitAndPush({ paths: ['b.md'], message: 'inbox: 收件 b' });
  assert.equal(r.ok, true);
  const log = git(origin, 'log', '--oneline', '-5');
  assert.match(log, /收件 b/);
  assert.match(log, /direct write elsewhere/);
});

test('commitAndPush：并发调用被串行化，两笔都落远端', async () => {
  const writer = createWriter({ instanceDir: work });
  writeFileSync(path.join(work, 'c1.md'), '1\n');
  writeFileSync(path.join(work, 'c2.md'), '2\n');
  const [r1, r2] = await Promise.all([
    writer.commitAndPush({ paths: ['c1.md'], message: 'inbox: 收件 c1' }),
    writer.commitAndPush({ paths: ['c2.md'], message: 'inbox: 收件 c2' }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const log = git(origin, 'log', '--oneline', '-5');
  assert.match(log, /收件 c1/);
  assert.match(log, /收件 c2/);
});

test('commitAndPush：没有变化时安全返回（不产生空提交）', async () => {
  const writer = createWriter({ instanceDir: work });
  const r = await writer.commitAndPush({ paths: ['a.md'], message: 'noop' });
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
});
