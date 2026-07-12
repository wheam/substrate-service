// 实例工作副本的 git 同步：启动 clone，周期 pull --ff-only（M2 前服务端是跟随者，只读不写）。
import { existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

function git(cwd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0]} 失败：${stderr || err.message}`)) : resolve(stdout));
  });
}

// git 通常会隐藏 URL userinfo，但不能把这个行为当安全边界；任何错误出日志/状态前再兜底剥一次。
export function sanitizeGitError(message) {
  return String(message ?? '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
}

export async function ensureRepo({ repoUrl, dir }) {
  if (existsSync(path.join(dir, '.git'))) return { cloned: false };
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(path.dirname(dir), ['clone', repoUrl, dir], 600_000);
  return { cloned: true };
}

export async function pullOnce(dir) {
  try {
    await git(dir, ['pull', '--ff-only']);
    return { ok: true, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, at: new Date().toISOString(), error: sanitizeGitError(e.message) };
  }
}

export function startPullLoop(dir, intervalMs, onResult) {
  const timer = setInterval(async () => onResult(await pullOnce(dir)), intervalMs);
  timer.unref?.();
  return timer;
}
