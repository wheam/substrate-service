// 主频道待裁提醒的持久冷却账本。只保存 token 的单向 hash 与 held id 集合，
// 不保存 token 明文、提案正文或任何知识库内容；状态位于实例 git 之外的 volume。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

function readState(statePath) {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    return value?.version === 1 && value.entries && typeof value.entries === 'object'
      ? value
      : { version: 1, entries: {} };
  } catch { return { version: 1, entries: {} }; }
}

function writeState(statePath, value) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

export function nudgeCredentialKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createNudgeState({
  statePath,
  ttlMs = 259_200_000,
  now = () => Date.now(),
}) {
  let state = readState(statePath);

  const persist = () => writeState(statePath, state);

  return {
    shouldEmit(credentialKey, heldKey) {
      const at = now();
      const previous = state.entries[credentialKey];
      if (previous?.key === heldKey && at - previous.at < ttlMs) return false;
      state.entries[credentialKey] = { key: heldKey, at };
      try { persist(); } catch { /* 状态盘故障时宁可重复提醒，也不影响主工具响应。 */ }
      return true;
    },
    clear(credentialKey) {
      if (!Object.hasOwn(state.entries, credentialKey)) return;
      delete state.entries[credentialKey];
      try { persist(); } catch { /* 清理失败只影响后续提醒频率。 */ }
    },
    read() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}
