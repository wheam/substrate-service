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
  applyDecisionPlan, assertCleanWorktree, rollbackUncommitted, validateDecisionPlan,
} from './executor.js';
import { createDoctorGate, describeDoctorFailure } from './doctor-gate.js';

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

// 一批页面一次事务：全部校验、依次写入、跑一次 doctor、一次提交；任何一步失败整批回滚。
// 一组互相链接的新页逐页直写时，前面的页会链到还不存在的后面的页，单页永远过不了 doctor
// （2026-10-18 的 18 页航旅记录即此），整批写入后链接全部可解析。单页直写是 pages.length === 1 的特例。
export const MAX_BATCH_PAGES = 50;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

function checkedBody(content, label) {
  const body = String(content ?? '');
  if (!body.trim()) throw directError('DIRECT_CONTENT_EMPTY', `直写内容不能为空${label}`);
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) {
    throw directError('DIRECT_CONTENT_TOO_LARGE', `直写内容超过 ${MAX_CONTENT_BYTES} bytes${label}`);
  }
  if (body.includes('\0')) throw directError('DIRECT_CONTENT_INVALID', `直写内容含 NUL${label}`);
  if (containsCredential(body)) {
    throw directError('DIRECT_CREDENTIAL', `拒收：内容含疑似密钥/凭据（红线：密钥原文绝不进库）。请脱敏后重试。${label}`);
  }
  return body;
}

export async function directPagesWrite({
  instanceDir, writer, indexStore = null, client, pages, doctor = true, doctorGate = null,
}) {
  const sourceClient = String(client ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sourceClient)) {
    throw directError('DIRECT_IDENTITY_INVALID', '可信直写 client 标识不合法，须为 1-64 位 A-Za-z0-9._-');
  }
  if (!Array.isArray(pages) || !pages.length) throw directError('DIRECT_BATCH_EMPTY', '批量直写至少要有一页');
  if (pages.length > MAX_BATCH_PAGES) {
    throw directError('DIRECT_BATCH_TOO_LARGE', `批量直写一次最多 ${MAX_BATCH_PAGES} 页（本次 ${pages.length} 页）`);
  }
  const batch = pages.length > 1;
  const items = pages.map((p, i) => ({
    page: p?.path, mode: p?.mode, expectedContentId: p?.expected_content_id ?? null,
    body: checkedBody(p?.content, batch ? `（第 ${i + 1} 页 ${String(p?.path ?? '')}）` : ''),
  }));
  const totalBytes = items.reduce((n, it) => n + Buffer.byteLength(it.body, 'utf8'), 0);
  if (totalBytes > MAX_BATCH_BYTES) {
    throw directError('DIRECT_BATCH_TOO_LARGE', `批量直写总内容超过 ${MAX_BATCH_BYTES} bytes`);
  }

  const gate = doctorGate ?? createDoctorGate({ instanceDir, enabled: doctor });
  let result;
  await writer.transact(async (commit) => {
    await assertCleanWorktree(instanceDir);
    const requestId = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    // 基线在任何写入之前取。批量的后续页要看到前面页写入后的状态（如同批先 create 再 append），
    // 所以路径/策略校验只能边写边做，失败即整批回滚。
    const doctorBase = await gate.baseline();
    let writeStarted = false;
    try {
      const changed = [];
      const written = [];
      for (const [i, it] of items.entries()) {
        const label = batch ? `（第 ${i + 1} 页）` : '';
        let target;
        try { target = validateDirectPageTarget({ instanceDir, page: it.page, mode: it.mode, expectedContentId: it.expectedContentId }); }
        catch (error) { if (batch) error.message += label; throw error; }
        const entry = {
          id: batch ? `${requestId}-${i + 1}` : requestId,
          body: it.body,
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
          action: it.mode === 'create' ? 'new_page' : 'merge_into',
          zone: target.zone.id,
          target: target.rel,
          title: path.posix.basename(target.rel, '.md'),
          page_type: target.zone.id,
          summary: `可信客户端明确${it.mode === 'create' ? '新建' : '追加'} ${target.rel}`,
          confidence: 1,
          links: [],
        };
        const validation = validateDecisionPlan({ instanceDir, decision, entry });
        if (!validation.ok || validation.verdict !== 'file') {
          throw directError('DIRECT_POLICY_DENIED', `${validation.reason || '可信直写未通过 effect policy'}${label}`);
        }
        writeStarted = true;
        const applied = await applyDecisionPlan({ instanceDir, entry, decision, validation });
        changed.push(...(applied.changedPaths ?? []));
        written.push({ path: target.rel, mode: it.mode, changed: (applied.changedPaths ?? []).length > 0 });
      }
      const gateResult = await gate.check(doctorBase);
      if (gateResult.unavailable) throw directError('DIRECT_DOCTOR_UNAVAILABLE', 'doctor 未返回可解析结果');
      if (!gateResult.ok) {
        const error = directError('DIRECT_DOCTOR_FAILED', describeDoctorFailure(gateResult));
        error.doctor = { new_errors: gateResult.newErrors, blocking_existing: gateResult.blockingExisting };
        throw error;
      }
      const changedPaths = [...new Set(changed)];
      const sync = await commit({
        paths: changedPaths.length ? changedPaths : written.map((w) => w.path),
        message: batch
          ? `direct: batch ${written.length} pages via ${sourceClient}`
          : `direct: ${written[0].mode} ${written[0].path} via ${sourceClient}`,
      });
      result = {
        route: 'direct', request_id: requestId, pages: written,
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

export async function directPageWrite({
  instanceDir, writer, indexStore = null, client, page, content, mode,
  expectedContentId = null, doctor = true, doctorGate = null,
}) {
  const r = await directPagesWrite({
    instanceDir, writer, indexStore, client, doctor, doctorGate,
    pages: [{ path: page, content, mode, expected_content_id: expectedContentId }],
  });
  const { pages: [only], ...rest } = r;
  return { ...rest, mode: only.mode, path: only.path };
}
