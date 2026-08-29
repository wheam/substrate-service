// 轻治理模式的可信直写：只接受高信任客户端明确指定的普通 Markdown 页 create/append。
// 不做语义路由、不做整页覆盖，也不触碰 Skill / governance / typed zones / 结构页；
// 确定性校验、doctor、Git 单写者与失败回滚仍与 keeper 正式写路径同级。
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseZones, SERVICE_ZONE_IDS, zoneFor } from './acl.js';
import { readContentId } from './content-id.js';
import { containsCredential } from './secrets.js';
import {
  applyDecisionPlan, assertCleanWorktree, rollbackUncommitted, runDoctor, validateDecisionPlan,
} from './executor.js';

const MAX_CONTENT_BYTES = 1024 * 1024;
const DENIED_ZONE_IDS = new Set([...SERVICE_ZONE_IDS, 'skills', 'todo', 'collections']);
const DENIED_PATH_ROOTS = ['governance/', 'skills/', 'inbox/', 'keeper-feedback/'];

function directError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function assertSafeParents(instanceDir, rel) {
  const root = path.resolve(instanceDir);
  const parts = rel.split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) continue;
    const st = lstatSync(cursor);
    if (st.isSymbolicLink()) throw directError('DIRECT_PATH_SYMLINK', `目标父路径含符号链接：${rel}`);
    if (!st.isDirectory()) throw directError('DIRECT_PATH_TYPE', `目标父路径不是目录：${rel}`);
  }
}

export function validateDirectPageTarget({ instanceDir, page, mode, expectedContentId = null }) {
  const rel = String(page ?? '').trim();
  if (!rel || rel.length > 500 || path.posix.isAbsolute(rel) || rel.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(rel) || path.posix.normalize(rel) !== rel
      || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw directError('DIRECT_PATH_INVALID', `直写路径不合法：${rel || '（空）'}`);
  }
  if (!rel.endsWith('.md')) throw directError('DIRECT_PATH_INVALID', '可信直写只接受 .md 页面');
  if (DENIED_PATH_ROOTS.some((prefix) => rel.startsWith(prefix))) {
    throw directError('DIRECT_ZONE_DENIED', `可信直写不允许触碰治理/Skill/流水区：${rel}`);
  }
  const structural = rel.split('/').some((part) => part === 'README.md' || part.startsWith('_') || part.startsWith('.'));
  if (structural) throw directError('DIRECT_STRUCTURE_DENIED', `可信直写不允许触碰结构页：${rel}`);
  if (mode !== 'create' && mode !== 'append') {
    throw directError('DIRECT_MODE_INVALID', 'mode 只接受 create 或 append');
  }

  const zones = parseZones(instanceDir);
  const zone = zoneFor(zones, rel);
  if (!zone || DENIED_ZONE_IDS.has(zone.id)) {
    throw directError('DIRECT_ZONE_DENIED', `目标不在允许直写的普通内容 zone：${rel}`);
  }
  if (zone.id === 'raw' && mode !== 'create') {
    throw directError('DIRECT_ZONE_DENIED', 'raw 区只允许可信直写新建，不允许追加既有原始素材');
  }

  assertSafeParents(instanceDir, rel);
  const abs = path.join(instanceDir, rel);
  const exists = existsSync(abs);
  if (exists) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw directError('DIRECT_PATH_TYPE', `直写目标不是普通文件：${rel}`);
    }
  }
  if (mode === 'create' && exists) throw directError('DIRECT_CREATE_CONFLICT', `目标页已存在：${rel}`);
  if (mode === 'append' && !exists) throw directError('DIRECT_APPEND_MISSING', `追加目标不存在：${rel}`);
  if (mode === 'create' && expectedContentId) {
    throw directError('DIRECT_CONTENT_ID_INVALID', 'create 不接受 expected_content_id');
  }
  if (mode === 'append' && expectedContentId) {
    const actual = readContentId(readFileSync(abs, 'utf8'));
    if (!actual || actual.toLowerCase() !== String(expectedContentId).toLowerCase()) {
      throw directError('DIRECT_CONTENT_ID_MISMATCH', `expected_content_id 与目标页不一致：${rel}`);
    }
  }
  return { rel, abs, zone };
}

export async function directPageWrite({
  instanceDir, writer, indexStore = null, client, page, content, mode,
  expectedContentId = null, doctor = true,
}) {
  const sourceClient = String(client ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sourceClient)) {
    throw directError('DIRECT_IDENTITY_INVALID', '可信直写 client 标识不合法，须为 1-64 位 A-Za-z0-9._-');
  }
  const body = String(content ?? '');
  if (!body.trim()) throw directError('DIRECT_CONTENT_EMPTY', '直写内容不能为空');
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) {
    throw directError('DIRECT_CONTENT_TOO_LARGE', `直写内容超过 ${MAX_CONTENT_BYTES} bytes`);
  }
  if (body.includes('\0')) throw directError('DIRECT_CONTENT_INVALID', '直写内容含 NUL');
  if (containsCredential(body)) {
    throw directError('DIRECT_CREDENTIAL', '拒收：内容含疑似密钥/凭据（红线：密钥原文绝不进库）。请脱敏后重试。');
  }

  let result;
  await writer.transact(async (commit) => {
    await assertCleanWorktree(instanceDir);
    const target = validateDirectPageTarget({ instanceDir, page, mode, expectedContentId });
    const requestId = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const entry = {
      id: requestId,
      body,
      client: sourceClient,
      kind: 'save',
      __direct: true,
      __native: true,
      __admission_enforced: true,
      __capabilities: ['page:create', 'page:append', 'target:explicit', 'zone:sensitive-write'],
    };
    const decision = {
      disposition: 'canonical',
      tier: 'canonical',
      action: mode === 'create' ? 'new_page' : 'merge_into',
      zone: target.zone.id,
      target: target.rel,
      title: path.posix.basename(target.rel, '.md'),
      page_type: target.zone.id,
      summary: `可信客户端明确${mode === 'create' ? '新建' : '追加'} ${target.rel}`,
      confidence: 1,
      links: [],
    };
    const validation = validateDecisionPlan({ instanceDir, decision, entry });
    if (!validation.ok || validation.verdict !== 'file') {
      throw directError('DIRECT_POLICY_DENIED', validation.reason || '可信直写未通过 effect policy');
    }

    let applied = null;
    let writeStarted = false;
    try {
      writeStarted = true;
      applied = await applyDecisionPlan({ instanceDir, entry, decision, validation });
      const errors = await runDoctor(instanceDir, { enabled: doctor });
      if (doctor && errors === null) throw directError('DIRECT_DOCTOR_UNAVAILABLE', 'doctor 未返回可解析结果');
      if (doctor && errors > 0) throw directError('DIRECT_DOCTOR_FAILED', `doctor 报 ${errors} error`);
      const changedPaths = [...new Set(applied.changedPaths ?? [])];
      const sync = await commit({
        paths: changedPaths.length ? changedPaths : [target.rel],
        message: `direct: ${mode} ${target.rel} via ${sourceClient}`,
      });
      result = {
        route: 'direct', mode, path: target.rel, request_id: requestId,
        changed: changedPaths.length > 0, changed_paths: changedPaths,
        ...(sync?.sync_pending ? { sync_pending: true } : {}),
      };
    } catch (error) {
      if (writeStarted) {
        try { await rollbackUncommitted(instanceDir); }
        catch (rollbackError) {
          throw directError('DIRECT_ROLLBACK_FAILED', `${error.message}；直写回滚失败：${rollbackError.message}`);
        }
      }
      throw error;
    }
  });

  if (indexStore && result?.changed_paths) {
    try {
      for (const rel of result.changed_paths) indexStore.updatePage(rel);
    } catch { /* 派生索引可重建；不回滚已经 durable 的正典写入 */ }
  }
  return result;
}
