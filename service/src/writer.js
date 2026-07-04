// 单写者 git 队列：所有服务端写入串行走这里，push 撞车时 pull --rebase 重试（撞车协议兜底）。
// keeper / inbox 共用同一个 writer 实例 —— 服务端只有一个写者，这是架构承诺。
import { execFile } from 'node:child_process';

const GIT_IDENTITY = ['-c', 'user.name=substrate-keeper', '-c', 'user.email=keeper@substrate-service.invalid'];

function git(cwd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_IDENTITY, ...args], { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} 失败：${stderr || err.message}`)) : resolve(stdout));
  });
}

export function createWriter({ instanceDir }) {
  let queue = Promise.resolve();

  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.then(() => {}, () => {}); // 一笔失败不阻塞后续
    return run;
  }

  async function doCommitPush({ paths, message }) {
    await git(instanceDir, ['add', '--', ...paths]);
    const staged = await git(instanceDir, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) return { ok: true, noop: true };
    await git(instanceDir, ['commit', '-m', message]);
    for (let attempt = 1; ; attempt++) {
      try {
        await git(instanceDir, ['push']);
        return { ok: true };
      } catch (e) {
        if (attempt >= 3) return { ok: false, error: e.message };
        await git(instanceDir, ['pull', '--rebase']);
      }
    }
  }

  return {
    commitAndPush: (opts) => enqueue(() => doCommitPush(opts)),
    enqueue, // keeper 归档等复合写操作也要进同一条队列
  };
}
