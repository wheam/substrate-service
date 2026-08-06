import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';

let origin, seed, work;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function createRepo(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const repoOrigin = path.join(base, 'origin.git');
  const repoSeed = path.join(base, 'seed');
  const repoWork = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', repoOrigin]);
  execFileSync('git', ['init', '-b', 'main', repoSeed]);
  writeFileSync(path.join(repoSeed, 'README.md'), 'seed\n');
  git(repoSeed, 'add', '-A');
  git(repoSeed, 'commit', '-m', 'seed');
  git(repoSeed, 'remote', 'add', 'origin', repoOrigin);
  git(repoSeed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', repoOrigin, repoWork]);
  return {
    base,
    origin: repoOrigin,
    seed: repoSeed,
    work: repoWork,
    statePath: path.join(base, 'writer-sync-state.json'),
  };
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

test('commitAndPush：本地 commit 后 rebase 冲突返回 sync_pending 语义，并退出 rebase 保留本地提交', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-writer-conflict-'));
  const conflictOrigin = path.join(base, 'origin.git');
  const conflictSeed = path.join(base, 'seed');
  const conflictWork = path.join(base, 'work');
  const rival = path.join(base, 'rival');
  execFileSync('git', ['init', '--bare', '-b', 'main', conflictOrigin]);
  execFileSync('git', ['init', '-b', 'main', conflictSeed]);
  writeFileSync(path.join(conflictSeed, 'shared.md'), 'base\n');
  git(conflictSeed, 'add', '-A');
  git(conflictSeed, 'commit', '-m', 'seed conflict repo');
  git(conflictSeed, 'remote', 'add', 'origin', conflictOrigin);
  git(conflictSeed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', conflictOrigin, conflictWork]);
  execFileSync('git', ['clone', conflictOrigin, rival]);

  writeFileSync(path.join(rival, 'shared.md'), 'remote\n');
  git(rival, 'add', 'shared.md');
  git(rival, 'commit', '-m', 'remote conflict');
  git(rival, 'push');

  writeFileSync(path.join(conflictWork, 'shared.md'), 'local\n');
  const writer = createWriter({ instanceDir: conflictWork });
  const result = await writer.commitAndPush({ paths: ['shared.md'], message: 'local durable conflict' });

  assert.equal(result.ok, false);
  assert.match(result.error, /push|rebase|CONFLICT|冲突/i);
  assert.equal(git(conflictWork, 'status', '--porcelain'), '', 'rebase 已 abort，工作树回到本地 durable commit');
  assert.match(git(conflictWork, 'log', '--oneline', '-1'), /local durable conflict/);
  assert.equal(readFileSync(path.join(conflictWork, 'shared.md'), 'utf8'), 'local\n');
  assert.equal(readFileSync(path.join(rival, 'shared.md'), 'utf8'), 'remote\n');
});

test('sync pending：远端恢复后新 writer 自动补推，不重放原事务回调', async () => {
  const repo = createRepo('substrate-writer-recovery-');
  const offlineOrigin = `${repo.origin}.offline`;
  renameSync(repo.origin, offlineOrigin);

  let businessRuns = 0;
  const writer = createWriter({ instanceDir: repo.work });
  const failed = await writer.transact(async (commit) => {
    businessRuns++;
    writeFileSync(path.join(repo.work, 'durable.md'), 'only once\n');
    return commit({ paths: ['durable.md'], message: 'local durable while offline' });
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.sync_pending, true);
  assert.equal(businessRuns, 1);
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, true);
  assert.match(git(repo.work, 'log', '--oneline', '-1'), /local durable while offline/);

  // 重启时远端仍不可用：纯 Git 重试失败，待办不得丢失。
  const stillOffline = createWriter({ instanceDir: repo.work });
  const pending = await stillOffline.commitAndPush({ paths: ['durable.md'], message: 'noop while offline' });
  assert.equal(pending.ok, false);
  assert.equal(pending.sync_pending, true);
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, true);

  renameSync(offlineOrigin, repo.origin);
  const recoveredBeforeNextTransaction = await stillOffline.commitAndPush({
    paths: ['durable.md'],
    message: 'noop after same-process recovery',
  });
  assert.equal(recoveredBeforeNextTransaction.ok, true, '下一笔事务前先补推旧提交链');
  assert.equal(recoveredBeforeNextTransaction.noop, true);
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, false);

  // 再制造一枚待办，单独验证“新 writer 初始化”的无业务补推路径。
  renameSync(repo.origin, offlineOrigin);
  writeFileSync(path.join(repo.work, 'restart-only.md'), 'restart recovery\n');
  const secondPending = await stillOffline.commitAndPush({
    paths: ['restart-only.md'],
    message: 'second local durable while offline',
  });
  assert.equal(secondPending.ok, false);
  assert.equal(secondPending.sync_pending, true);
  renameSync(offlineOrigin, repo.origin);

  const restarted = createWriter({ instanceDir: repo.work });
  // 这笔无变化调用只用来等待初始化补推完成；补推本身不调用上面的业务回调。
  const recovered = await restarted.commitAndPush({ paths: ['restart-only.md'], message: 'noop after restart recovery' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.noop, true);
  assert.equal(businessRuns, 1);
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, false);
  assert.equal(git(repo.origin, 'show', 'main:durable.md'), 'only once\n');
  assert.equal(git(repo.origin, 'show', 'main:restart-only.md'), 'restart recovery\n');
  assert.equal(
    git(repo.origin, 'log', '--format=%s', '--all').split(/\r?\n/).filter((line) => line === 'local durable while offline').length,
    1,
  );
});

test('sync pending：网络恢复后即使没有新业务写入，后台周期也会补推', async () => {
  const repo = createRepo('substrate-writer-periodic-recovery-');
  const offlineOrigin = `${repo.origin}.offline`;
  renameSync(repo.origin, offlineOrigin);
  let businessRuns = 0;
  const writer = createWriter({ instanceDir: repo.work, syncRetryMs: 25 });
  const failed = await writer.transact(async (commit) => {
    businessRuns++;
    writeFileSync(path.join(repo.work, 'periodic.md'), 'periodic recovery\n');
    return commit({ paths: ['periodic.md'], message: 'periodic durable commit' });
  });
  assert.equal(failed.ok, false);
  renameSync(offlineOrigin, repo.origin);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const remoteReady = git(repo.origin, 'show', 'main:periodic.md') === 'periodic recovery\n';
      const stateReady = JSON.parse(readFileSync(repo.statePath, 'utf8')).pending === false;
      if (remoteReady && stateReady) break;
    } catch { /* 后台 tick 尚未补推 */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(git(repo.origin, 'show', 'main:periodic.md'), 'periodic recovery\n');
  assert.equal(businessRuns, 1, '后台补推绝不能重跑事务 callback');
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, false);
});

test('sync state 损坏：补推不成时 fail-safe 拒绝业务回调，远端恢复后可自愈', async () => {
  const repo = createRepo('substrate-writer-corrupt-');
  const corruptRaw = '{ definitely not valid json\n';
  writeFileSync(repo.statePath, corruptRaw);
  const offlineOrigin = `${repo.origin}.offline`;
  renameSync(repo.origin, offlineOrigin);

  let businessRuns = 0;
  const degraded = createWriter({ instanceDir: repo.work });
  await assert.rejects(
    degraded.transact(async () => { businessRuns++; }),
    /sync state 损坏且补推失败/,
  );
  assert.equal(businessRuns, 0);
  assert.equal(readFileSync(repo.statePath, 'utf8'), corruptRaw, '未确认的损坏状态不得被当成 clean 覆盖');

  renameSync(offlineOrigin, repo.origin);
  const recovered = createWriter({ instanceDir: repo.work });
  writeFileSync(path.join(repo.work, 'after-recovery.md'), 'safe\n');
  const result = await recovered.commitAndPush({ paths: ['after-recovery.md'], message: 'write after state recovery' });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(readFileSync(repo.statePath, 'utf8')).pending, false);
  assert.equal(git(repo.origin, 'show', 'main:after-recovery.md'), 'safe\n');
});

test('sync state 无法落盘时在本地 commit 之前失败', async () => {
  const repo = createRepo('substrate-writer-state-fail-');
  const blockingFile = path.join(repo.base, 'not-a-directory');
  writeFileSync(blockingFile, 'block mkdir\n');
  const writer = createWriter({
    instanceDir: repo.work,
    syncStatePath: path.join(blockingFile, 'writer-sync-state.json'),
  });
  writeFileSync(path.join(repo.work, 'must-not-commit.md'), 'not committed\n');

  await assert.rejects(
    writer.commitAndPush({ paths: ['must-not-commit.md'], message: 'must not become durable' }),
    /EEXIST|ENOTDIR/,
  );
  assert.doesNotMatch(git(repo.work, 'log', '--oneline', '-1'), /must not become durable/);
  assert.doesNotMatch(git(repo.origin, 'log', '--oneline', '-1'), /must not become durable/);
});
