// 服务端 proof registry。inbox 文件在 git 里，所以文件自报的 admission/owner approval
// 都不能当信任根；内容绑定 proof 与批准票住在实例 git 外的 service volume。
// v2 同时保留 consumed id tombstone：执行器在落最终 commit 前先持久消费 proof，历史 inbox
// 即使从 git 恢复也不能复燃。状态损坏时 fail closed：保留原文件、不覆盖并拒绝新签发。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9-]{1,80}$/;
const META_RE = /^[a-zA-Z0-9._:-]{1,80}$/;

function validTokenMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id, token]) => ID_RE.test(id) && HASH_RE.test(token));
}

function validApproval(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && HASH_RE.test(value.token)
    && (value.viaTrust == null || META_RE.test(value.viaTrust))
    && (value.viaChannel == null || META_RE.test(value.viaChannel));
}

function sameApproval(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.token === b.token
    && (a.viaTrust ?? null) === (b.viaTrust ?? null)
    && (a.viaChannel ?? null) === (b.viaChannel ?? null);
}

function decodeState(value) {
  // v1 自动迁移：旧 entries 全部仍是 active，首次 mutation 时写成 v2。
  if (value?.version === 1 && validTokenMap(value.entries)) {
    return { active: new Map(Object.entries(value.entries)), consumed: new Set(), approvals: new Map() };
  }
  if (value?.version !== 2 || !validTokenMap(value.active)
      || !Array.isArray(value.consumed) || !value.consumed.every((id) => ID_RE.test(id))
      || new Set(value.consumed).size !== value.consumed.length
      || !value.approvals || typeof value.approvals !== 'object' || Array.isArray(value.approvals)
      || !Object.entries(value.approvals).every(([id, rec]) => ID_RE.test(id) && validApproval(rec))) return null;
  const consumed = new Set(value.consumed);
  if (Object.keys(value.active).some((id) => consumed.has(id))) return null;
  if (Object.keys(value.approvals).some((id) => consumed.has(id))) return null;
  return {
    active: new Map(Object.entries(value.active)),
    consumed,
    approvals: new Map(Object.entries(value.approvals)),
  };
}

export function createNativeRegistry({ statePath } = {}) {
  let degraded = false;
  let registry = new Map();
  let consumed = new Set();
  let approvalRecords = new Map();
  if (statePath && existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const decoded = decodeState(state);
      if (!decoded) throw new Error('invalid shape');
      registry = decoded.active;
      consumed = decoded.consumed;
      approvalRecords = decoded.approvals;
    } catch {
      degraded = true;
      console.error(`native registry 损坏或结构不合格（${statePath}）——旧件权限将安全失效，文件保留待人工处理`);
    }
  }

  const persist = () => {
    if (!statePath || degraded) return;
    mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const active = Object.fromEntries([...registry.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const approvals = Object.fromEntries([...approvalRecords.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const state = { version: 2, active, consumed: [...consumed].sort(), approvals };
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  };

  const guardWritable = () => {
    if (degraded) throw new Error('native registry 已降级，拒绝受理无法持久证明权限的新收件');
  };

  const normalizeApproval = (record) => {
    const clean = {
      token: String(record?.token ?? ''),
      viaTrust: record?.viaTrust == null ? null : String(record.viaTrust),
      viaChannel: record?.viaChannel == null ? null : String(record.viaChannel),
    };
    if (!validApproval(clean)) throw new Error('approval registry 拒绝非法记录');
    return clean;
  };

  const approvalStore = {
    get(id) { return approvalRecords.get(id); },
    has(id) { return approvalRecords.has(id); },
    get size() { return approvalRecords.size; },
    set(id, record) {
      guardWritable();
      id = String(id);
      if (!ID_RE.test(id) || consumed.has(id)) throw new Error('approval registry 拒绝非法或已消费 id');
      const clean = normalizeApproval(record);
      const previous = approvalRecords.get(id);
      approvalRecords.set(id, clean);
      try { persist(); }
      catch (e) {
        if (previous === undefined) approvalRecords.delete(id);
        else approvalRecords.set(id, previous);
        throw new Error(`approval registry 落盘失败，裁定未受理：${e.message}`);
      }
      return this;
    },
    delete(id) {
      guardWritable();
      id = String(id);
      const previous = approvalRecords.get(id);
      if (previous === undefined) return false;
      approvalRecords.delete(id);
      try { persist(); }
      catch (e) {
        approvalRecords.set(id, previous);
        throw new Error(`approval registry 销账失败：${e.message}`);
      }
      return true;
    },
  };

  return {
    get degraded() { return degraded; },
    get size() { return registry.size; },
    get approvals() { return approvalStore; },
    get(id) { return registry.get(id); },
    has(id) { return registry.has(id); },
    isConsumed(id) { return consumed.has(id); },
    set(id, token) {
      if (!ID_RE.test(String(id)) || !HASH_RE.test(String(token))) throw new Error('native registry 拒绝非法 id/token');
      guardWritable();
      id = String(id);
      if (consumed.has(id)) throw new Error('native registry 拒绝复用已消费 id');
      const previous = registry.get(id);
      registry.set(id, String(token));
      try { persist(); }
      catch (e) {
        if (previous === undefined) registry.delete(id);
        else registry.set(id, previous);
        throw new Error(`native registry 落盘失败，收件未受理：${e.message}`);
      }
      return this;
    },
    // 执行前持久 claim：active -> consumed tombstone，并同批销掉 owner approval。
    // persist 失败会完整回滚内存并抛错，调用方因此不得继续执行。
    consume(id, expectedToken = null, expectedApproval = undefined) {
      guardWritable();
      id = String(id);
      const token = registry.get(id);
      if (token === undefined) return false;
      if (expectedToken != null && token !== expectedToken) throw new Error('native proof 与待消费 token 不一致');
      const approval = approvalRecords.get(id);
      if (expectedApproval !== undefined && !sameApproval(approval ?? null, expectedApproval)) {
        throw new Error('owner approval 在待执行期间已变化，拒绝消费旧计划');
      }
      registry.delete(id);
      approvalRecords.delete(id);
      consumed.add(id);
      try { persist(); }
      catch (e) {
        consumed.delete(id);
        registry.set(id, token);
        if (approval !== undefined) approvalRecords.set(id, approval);
        throw new Error(`native proof 消费落盘失败，拒绝执行：${e.message}`);
      }
      return { token, approval: approval ?? null };
    },
    // 只有“执行/commit 明确失败且文件已恢复”时调用。若进程在 consume 后崩溃，不会自动
    // restore——保留 tombstone 选择 at-most-once/fail-closed，由人工重新投递。
    restore(id, token, approval = null) {
      guardWritable();
      id = String(id);
      if (!ID_RE.test(id) || !HASH_RE.test(String(token)) || !consumed.has(id)) {
        throw new Error('native proof 恢复请求不合法或 id 未处于 consumed');
      }
      const cleanApproval = approval == null ? null : normalizeApproval(approval);
      consumed.delete(id);
      registry.set(id, String(token));
      if (cleanApproval) approvalRecords.set(id, cleanApproval);
      try { persist(); }
      catch (e) {
        registry.delete(id);
        approvalRecords.delete(id);
        consumed.add(id);
        throw new Error(`native proof 恢复落盘失败：${e.message}`);
      }
      return true;
    },
    // 兼容旧调用；语义已是“消费并留 tombstone”，不再物理遗忘 id。
    delete(id) {
      return !!this.consume(id);
    },
    entries() { return registry.entries(); },
  };
}
