import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureRepo, pullOnce } from '../src/repo.js';

let origin; // bare 仓库当远端
let seed;   // 往远端推内容用的工作副本
let workDir;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

before(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-repo-'));
  origin = path.join(base, 'origin.git');
  seed = path.join(base, 'seed');
  workDir = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'README.md'), 'v1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'v1');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
});

test('ensureRepo：目录为空则 clone', async () => {
  await ensureRepo({ repoUrl: origin, dir: workDir });
  assert.ok(existsSync(path.join(workDir, 'README.md')));
  assert.equal(readFileSync(path.join(workDir, 'README.md'), 'utf8'), 'v1\n');
});

test('ensureRepo：已存在则不动、不报错', async () => {
  await ensureRepo({ repoUrl: origin, dir: workDir });
  assert.ok(existsSync(path.join(workDir, 'README.md')));
});

test('pullOnce：拉到远端新提交', async () => {
  writeFileSync(path.join(seed, 'README.md'), 'v2\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'v2');
  git(seed, 'push');
  const result = await pullOnce(workDir);
  assert.equal(result.ok, true);
  assert.equal(readFileSync(path.join(workDir, 'README.md'), 'utf8'), 'v2\n');
});

test('pullOnce：远端不可达时返回 ok=false 不抛', async () => {
  const detached = mkdtempSync(path.join(tmpdir(), 'substrate-detached-'));
  execFileSync('git', ['clone', origin, path.join(detached, 'clone')]);
  git(path.join(detached, 'clone'), 'remote', 'set-url', 'origin', path.join(detached, 'gone.git'));
  const result = await pullOnce(path.join(detached, 'clone'));
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
