// 单写者 git 队列：所有服务端写入串行走这里，push 撞车时 pull --rebase 重试（撞车协议兜底）。
// keeper / inbox 共用同一个 writer 实例 —— 服务端只有一个写者，这是架构承诺。
//
// 本地 commit 与远端 push 不是原子操作。writer 因此在实例 git 外保留一枚 sync pending
// 状态：重启及每笔事务前只重试当前本地提交链，绝不重放产生这些提交的业务回调。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GIT_IDENTITY = ['-c', 'user.name=substrate-keeper', '-c', 'user.email=keeper@substrate-service.invalid'];
const SYNC_STATE_VERSION = 1;

function git(cwd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_IDENTITY, ...args], { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} 失败：${stderr || err.message}`)) : resolve(stdout));
  });
}

function isInside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function decodeSyncState(value, instanceDir) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== SYNC_STATE_VERSION
      || value.instanceDir !== instanceDir
      || typeof value.pending !== 'boolean') return null;
  return { pending: value.pending };
}

export function createWriter({ instanceDir, syncStatePath = null, syncRetryMs = 60_000 }) {
  instanceDir = path.resolve(instanceDir);
  const statePath = path.resolve(syncStatePath ?? path.join(instanceDir, '..', 'writer-sync-state.json'));
  if (isInside(instanceDir, statePath)) {
    throw new Error(`writer sync state 必须位于实例 git 外：${statePath}`);
  }

  let syncPending = false;
  let stateCorrupt = false;
  let lastSyncError = null;
  if (existsSync(statePath)) {
    try {
      const decoded = decodeSyncState(JSON.parse(readFileSync(statePath, 'utf8')), instanceDir);
      if (!decoded) throw new Error('invalid shape');
      syncPending = decoded.pending;
    } catch {
      // 不把损坏解释成“无待办”。先按有待办重试整条本地分支；只有 push
      // 成功才能用新的 clean state 覆盖损坏文件。
      syncPending = true;
      stateCorrupt = true;
      console.error(`writer sync state 损坏或与实例不匹配（${statePath}）——将先尝试补推，失败时拒绝新事务`);
    }
  }

  function persistSyncState(pending, { recover = false } = {}) {
    if (stateCorrupt && !recover) throw new Error('writer sync state 已损坏，拒绝覆盖未确认的同步待办');
    mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({
        version: SYNC_STATE_VERSION,
        instanceDir,
        pending,
      }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, statePath);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 仅清理本次临时文件 */ }
      throw e;
    }
    syncPending = pending;
    stateCorrupt = false;
  }

  async function pushCurrentChain() {
    for (let attempt = 1; ; attempt++) {
      try {
        await git(instanceDir, ['push']);
        return { ok: true };
      } catch (e) {
        if (attempt >= 3) return { ok: false, error: e.message, sync_pending: true };
        try {
          await git(instanceDir, ['pull', '--rebase']);
        } catch (rebaseError) {
          // 本地 commit 已经成功，后续同步失败不能再抛成“写入未落地”：keeper 无法
          // rollback 一个已提交对象，若误 re-held 会把同一收件再次执行。先退出冲突中的
          // rebase、恢复本地 durable commit，再统一返回 sync_pending。
          try { await git(instanceDir, ['rebase', '--abort']); } catch { /* 没进入 rebase 或 abort 失败，错误一并上报 */ }
          return { ok: false, error: `${e.message}；${rebaseError.message}`, sync_pending: true };
        }
      }
    }
  }

  async function retryPendingSync() {
    if (!syncPending && !stateCorrupt) return { ok: true, noop: true };
    const pushed = await pushCurrentChain();
    if (!pushed.ok) {
      lastSyncError = pushed.error;
      return pushed;
    }
    try {
      // push 成功证明当前本地提交链已达远端，因此也是唯一允许修复
      // corrupt state 的时机。
      persistSyncState(false, { recover: true });
      lastSyncError = null;
      return { ok: true };
    } catch (e) {
      lastSyncError = `远端已 push，但 sync state 清账失败：${e.message}`;
      return { ok: false, error: lastSyncError, sync_pending: true };
    }
  }

  // 创建 writer 即启动一次纯 Git 补推；第一笔事务会排在它之后。
  // retryPendingSync 将所有可预期故障收敛为结果，不会造成 queue rejection。
  let queue = Promise.resolve().then(retryPendingSync);
  let firstTransaction = true;

  function enqueue(fn) {
    const usesInitializationRetry = firstTransaction;
    firstTransaction = false;
    const run = queue.then(async () => {
      if (!usesInitializationRetry) await retryPendingSync();
      if (stateCorrupt) {
        throw new Error(`writer sync state 损坏且补推失败，拒绝进入新事务：${lastSyncError ?? '未知错误'}`);
      }
      return fn();
    });
    queue = run.then(() => {}, () => {}); // 一笔失败不阻塞后续
    return run;
  }

  function enqueueSyncRetry() {
    const run = queue.then(retryPendingSync);
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function doCommitPush({ paths, message }) {
    await git(instanceDir, ['add', '--', ...paths]);
    const staged = await git(instanceDir, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      if (syncPending) {
        return { ok: false, error: lastSyncError ?? '本地提交链仍待同步', sync_pending: true };
      }
      return { ok: true, noop: true };
    }

    // 先落待办再 commit：进程可以在任意后续节点崩溃，但不会出现“已有
    // 本地 durable commit 却没有同步提醒”的窗口。旧待办存在时不能因本次 commit
    // 失败而清掉它。
    const hadPending = syncPending;
    if (!hadPending) persistSyncState(true);
    try {
      await git(instanceDir, ['commit', '-m', message]);
    } catch (e) {
      if (!hadPending) {
        try { persistSyncState(false); }
        catch (stateError) {
          throw new Error(`${e.message}；回滚 sync state 失败：${stateError.message}`);
        }
      }
      throw e;
    }

    const pushed = await pushCurrentChain();
    if (!pushed.ok) {
      lastSyncError = pushed.error;
      return pushed;
    }
    try {
      persistSyncState(false);
      lastSyncError = null;
      return { ok: true };
    } catch (e) {
      lastSyncError = `远端已 push，但 sync state 清账失败：${e.message}`;
      return { ok: false, error: lastSyncError, sync_pending: true };
    }
  }

  const retryInterval = Number(syncRetryMs);
  if (Number.isFinite(retryInterval) && retryInterval > 0) {
    setInterval(() => {
      void enqueueSyncRetry().catch((e) => {
        lastSyncError = e.message;
        console.error(`writer 后台补推失败（保留 sync pending）：${e.message}`);
      });
    }, retryInterval).unref?.();
  }

  return {
    commitAndPush: (opts) => enqueue(() => doCommitPush(opts)),
    // 复合写操作（改文件 + 提交须原子）：整段进队列，fn 拿到裸 commit 用
    transact: (fn) => enqueue(() => fn(doCommitPush)),
    // 运维/测试可显式触发；生产同时有 unref 周期补推。这里只推 Git 提交链，绝不重放业务回调。
    retryPendingSync: enqueueSyncRetry,
  };
}
