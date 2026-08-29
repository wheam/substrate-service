// Skill staging / review / promotion 的确定性实现。
//
// 安全边界：
// - 普通 save 只能写 skills/_incoming/<name>/...，不能借本模块直写 skills/<name>/。
// - 晋升只接受服务端亲生 skill review 件 + 内容绑定 owner approval；批准绑定整棵目录 revision。
// - 正式目录默认必须不存在；同文件系统 rename 原子切换，doctor/commit 失败时 rename 回原位。
// - capabilities 的风险判定沿用 substrate-intake：不信 risk_level 自报，未知/缺失/歧义一律人工 audit。
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { newContentId, readContentId } from './content-id.js';
import { INBOX_PREVIEW_CHARS, parseEntryBody, scanSegments } from './inbox.js';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const STAGED_SKILL_RE = /^skills\/_incoming\/([a-z0-9][a-z0-9._-]*)\/(.+)$/;
export const PROMOTION_AUDIT_REL = 'keeper-feedback/_skill-promotions.jsonl';

const SAFE_CAPABILITIES = new Set(['read', 'write', 'read-markdown', 'write-markdown', 'markdown']);
const DANGEROUS_CAPABILITIES = new Set([
  'shell', 'system', 'network', 'install', 'secrets', 'modify-skills', 'modify-governance',
]);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const MAX_STAGE_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ITEMS = 256;
const pendingPromotionRollbacks = new Map();

export class SkillPromotionError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillPromotionError(code, message);
}

function oneline(value) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function stripComment(value) {
  return String(value).replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

function frontmatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '');
  const m = normalized.match(/^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  return m ? { body: m[1], full: normalized, match: m[0] } : null;
}

function scalar(fm, key) {
  const hits = [...fm.matchAll(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'gm'))];
  if (hits.length !== 1) return { value: null, status: hits.length ? 'duplicate' : 'absent' };
  const value = stripComment(hits[0][1]);
  return { value: value || null, status: value ? 'ok' : 'empty' };
}

// 与 v1 substrate-intake/gate.py 同口径：inline / block list；重复、标量、块内混入非列表行均不猜。
function listField(fm, key) {
  const declarations = [...fm.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*:`, 'gm'))];
  if (declarations.length > 1) return { values: [], status: 'duplicate' };
  const inline = fm.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*\\[([^\\]\\r\\n]*)\\][ \\t]*(?:#.*)?$`, 'm'));
  if (inline) {
    const values = inline[1].split(',').map(stripComment).filter(Boolean);
    return values.length <= MAX_LIST_ITEMS ? { values, status: 'ok' } : { values: [], status: 'too-many' };
  }
  const header = fm.match(new RegExp(`^([ \\t]*)${key}[ \\t]*:[ \\t]*$`, 'm'));
  if (!header) return { values: [], status: declarations.length ? 'malformed' : 'absent' };
  const keyIndent = header[1].replace(/\t/g, '    ').length;
  const values = [];
  for (const line of fm.slice((header.index ?? 0) + header[0].length).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.slice(0, line.length - line.trimStart().length).replace(/\t/g, '    ').length;
    if (indent <= keyIndent) break;
    const item = line.trim().match(/^-[ \t]*(.+)$/);
    if (!item) return { values, status: 'malformed' };
    const value = stripComment(item[1]);
    if (value) values.push(value);
    if (values.length > MAX_LIST_ITEMS) return { values: [], status: 'too-many' };
  }
  return values.length ? { values, status: 'ok' } : { values, status: 'empty' };
}

export function parseSkillDocument(raw) {
  const fm = frontmatter(raw);
  if (!fm) return { ok: false, code: 'SKILL_MANIFEST_INVALID', reason: 'Skill 内容必须是带 frontmatter 的完整 SKILL.md' };
  const nameField = scalar(fm.body, 'name');
  if (nameField.status !== 'ok' || !SKILL_NAME_RE.test(nameField.value)) {
    return { ok: false, code: 'SKILL_MANIFEST_INVALID', reason: 'Skill frontmatter 的 name 缺失、重复或格式不合法' };
  }
  const runtimes = listField(fm.body, 'target_runtimes');
  if (runtimes.status !== 'ok' || runtimes.values.length === 0) {
    return { ok: false, code: 'SKILL_MANIFEST_INVALID', reason: 'Skill frontmatter 的 target_runtimes 必须是非空列表且不可重复/歧义' };
  }
  const risk = scalar(fm.body, 'risk_level');
  const riskLevel = String(risk.value ?? '').toLowerCase();
  if (risk.status !== 'ok' || !RISK_LEVELS.has(riskLevel)) {
    return { ok: false, code: 'SKILL_MANIFEST_INVALID', reason: 'Skill frontmatter 的 risk_level 必须是 low|medium|high 且不可重复' };
  }
  const capabilities = listField(fm.body, 'capabilities');
  const normalizedCaps = capabilities.values.map((c) => c.trim().toLowerCase()).filter(Boolean);
  const dangerous = [...new Set(normalizedCaps.filter((c) => DANGEROUS_CAPABILITIES.has(c)))].sort();
  const unknown = [...new Set(normalizedCaps.filter((c) => !SAFE_CAPABILITIES.has(c) && !DANGEROUS_CAPABILITIES.has(c)))].sort();
  const gateAllowsAutomatic = capabilities.status === 'ok' && dangerous.length === 0 && unknown.length === 0;
  const admission = gateAllowsAutomatic ? 'eligible-after-owner-review' : 'manual-audit-required';
  const admissionReasons = [];
  if (capabilities.status !== 'ok') admissionReasons.push(`capabilities ${capabilities.status}`);
  if (dangerous.length) admissionReasons.push(`危险能力：${dangerous.join(', ')}`);
  if (unknown.length) admissionReasons.push(`未知能力：${unknown.join(', ')}`);
  return {
    ok: true,
    name: nameField.value,
    targetRuntimes: runtimes.values,
    riskLevel,
    capabilities: normalizedCaps,
    capabilitiesStatus: capabilities.status,
    dangerous,
    unknown,
    admission,
    admissionReason: admissionReasons.join('；') || 'capabilities 仅含已知安全能力；本服务仍要求 owner 审核',
  };
}

export function skillDocumentWithContentId(raw, contentId = newContentId()) {
  const parsed = parseSkillDocument(raw);
  if (!parsed.ok) fail(parsed.code, parsed.reason);
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^\s*(?=---\n)/, '');
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) fail('SKILL_MANIFEST_INVALID', 'Skill 内容必须是带 frontmatter 的完整 SKILL.md');
  const fm = m[1].split('\n').filter((line) => !/^\s*content_id\s*:/.test(line));
  const rest = text.slice(m[0].length);
  return `---\ncontent_id: ${contentId}\n${fm.join('\n')}\n---\n${rest}`;
}

export function validateStagedSkillPath(rel) {
  const value = String(rel ?? '');
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail('SKILL_PATH_INVALID', `Skill staging 路径不合法：${value}`);
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) fail('SKILL_PATH_INVALID', 'Skill staging 路径含控制/格式字符');
  const hit = value.match(STAGED_SKILL_RE);
  if (!hit) fail('SKILL_PATH_INVALID', 'Skill staging 只允许 skills/_incoming/<name>/<resource>');
  const resource = hit[2];
  const segments = resource.split('/');
  if (!segments.length || segments.some((s) => !s || s === '.' || s === '..' || s === '.git')) {
    fail('SKILL_PATH_INVALID', `Skill resource 路径不合法：${resource}`);
  }
  return { name: hit[1], resource, root: resource === 'SKILL.md' };
}

export function resolveSafeStagedSkillPath(instanceDir, rel) {
  const parsed = validateStagedSkillPath(rel);
  const root = path.resolve(instanceDir);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) fail('SKILL_PATH_INVALID', `Skill staging 路径越界：${rel}`);
  let cursor = root;
  for (const segment of rel.split('/').slice(0, -1)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      fail('SKILL_RESOURCE_UNSAFE', `Skill staging 父路径不允许符号链接：${path.relative(root, cursor)}`);
    }
  }
  return { ...parsed, abs };
}

export function validateStageContent(content) {
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_STAGE_FILE_BYTES) fail('SKILL_FILE_TOO_LARGE', `单个 Skill resource 超过 ${MAX_STAGE_FILE_BYTES} bytes`);
  if (text.includes('\0')) fail('SKILL_FILE_TYPE_UNSAFE', 'save 只接受 UTF-8 文本 resource，内容不得含 NUL；二进制资源须走受控文件导入流程');
  return { text, bytes };
}

function walkSkillDir(root) {
  const files = [];
  const stack = [''];
  let totalBytes = 0;
  while (stack.length) {
    const dir = stack.pop();
    const absDir = path.join(root, dir);
    for (const name of readdirSync(absDir)) {
      const rel = dir ? `${dir}/${name}` : name;
      validateStagedSkillPath(`skills/_incoming/x/${rel}`);
      const abs = path.join(root, rel);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) fail('SKILL_RESOURCE_UNSAFE', `Skill resource 不允许符号链接：${rel}`);
      if (st.isDirectory()) { stack.push(rel); continue; }
      if (!st.isFile()) fail('SKILL_RESOURCE_UNSAFE', `Skill resource 必须是普通文件：${rel}`);
      if (st.size > MAX_STAGE_FILE_BYTES) fail('SKILL_FILE_TOO_LARGE', `Skill resource 过大：${rel}`);
      totalBytes += st.size;
      files.push({ rel, abs, bytes: st.size });
      if (files.length > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
        fail('SKILL_TREE_TOO_LARGE', `Skill 目录超过 ${MAX_SKILL_FILES} 个文件或 ${MAX_SKILL_BYTES} bytes`);
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, totalBytes };
}

export function inspectSkillDirectory(instanceDir, name, { location = 'incoming' } = {}) {
  if (!SKILL_NAME_RE.test(String(name ?? ''))) fail('SKILL_NAME_INVALID', `Skill name 不合法：${name}`);
  const baseRel = location === 'canonical' ? `skills/${name}` : `skills/_incoming/${name}`;
  const base = path.join(instanceDir, baseRel);
  if (!existsSync(base)) fail('SKILL_NOT_FOUND', `找不到 Skill 目录：${baseRel}/`);
  let cursor = path.resolve(instanceDir);
  for (const segment of baseRel.split('/')) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      fail('SKILL_RESOURCE_UNSAFE', `Skill 目录或父路径不允许符号链接：${path.relative(instanceDir, cursor)}`);
    }
  }
  if (!lstatSync(base).isDirectory()) fail('SKILL_NOT_FOUND', `Skill 路径不是目录：${baseRel}/`);
  const rootPath = path.join(base, 'SKILL.md');
  if (!existsSync(rootPath) || !lstatSync(rootPath).isFile()) fail('SKILL_ROOT_MISSING', `${baseRel}/SKILL.md 不存在或不是普通文件`);
  const rootRaw = readFileSync(rootPath, 'utf8');
  const manifest = parseSkillDocument(rootRaw);
  if (!manifest.ok) fail(manifest.code, manifest.reason);
  if (manifest.name !== name) fail('SKILL_NAME_MISMATCH', `Skill name（${manifest.name}）与目录（${name}）不一致`);
  const contentId = readContentId(rootRaw);
  if (!contentId) fail('SKILL_CONTENT_ID_MISSING', 'staged SKILL.md 缺合法 8 位 content_id');
  const { files, totalBytes } = walkSkillDir(base);
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(file.abs);
    digest.update(file.rel).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
  }
  return {
    name,
    location,
    source: `${baseRel}/`,
    target: `skills/${name}/`,
    content_id: contentId,
    revision: digest.digest('hex'),
    file_count: files.length,
    total_bytes: totalBytes,
    files: files.map((f) => ({ path: f.rel, bytes: f.bytes })),
    manifest,
  };
}

function firstJsonPayload(raw) {
  const parsed = parseEntryBody(String(raw ?? ''));
  for (const seg of scanSegments(parsed.scanBody)) {
    if (seg.kind !== 'fence' || seg.info !== 'json') continue;
    const visible = scanSegments(parsed.content).find((s) => s.kind === 'fence' && s.info === 'json');
    if (!visible || visible.end > INBOX_PREVIEW_CHARS) return null;
    const execText = parsed.scanBody.slice(seg.innerStart, seg.innerEnd).replace(/\r?\n$/, '');
    const visibleText = parsed.content.slice(visible.innerStart, visible.innerEnd).replace(/\r?\n$/, '');
    if (execText !== visibleText) return null;
    try { return JSON.parse(execText); } catch { return null; }
  }
  return null;
}

export function parseSkillPromotionProposal(entry) {
  const payload = firstJsonPayload(entry?.raw ?? entry?.body ?? '');
  if (!payload || payload.version !== 1 || !SKILL_NAME_RE.test(payload.name)
      || !/^[0-9a-f]{8}$/.test(payload.content_id)
      || !/^[0-9a-f]{64}$/.test(payload.revision)
      || payload.source !== `skills/_incoming/${payload.name}/`
      || payload.target !== `skills/${payload.name}/`) return null;
  return payload;
}

function auditRecords(instanceDir) {
  const abs = path.join(instanceDir, PROMOTION_AUDIT_REL);
  if (!existsSync(abs)) return [];
  const records = [];
  for (const line of readFileSync(abs, 'utf8').split('\n').filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (value?.version === 1 && value?.result === 'promoted') records.push(value);
    } catch { /* 损坏审计行不作为幂等凭据；目标冲突仍会 fail closed */ }
  }
  return records;
}

function completedPromotion(instanceDir, { name, content_id, revision, receipt_id = null }) {
  const record = auditRecords(instanceDir).findLast((r) => r.name === name && r.content_id === content_id
    && r.revision === revision && (receipt_id == null || r.receipt_id === receipt_id));
  if (!record) return null;
  try {
    const current = inspectSkillDirectory(instanceDir, name, { location: 'canonical' });
    return current.content_id === content_id && current.revision === revision ? { record, current } : null;
  } catch { return null; }
}

export function requestSkillPromotion({ instanceDir, inbox, name, contentId, revision, client, admission }) {
  if (admission?.trust !== 'high' || !Array.isArray(admission?.capabilities) || !admission.capabilities.includes('skill:propose')) {
    fail('SKILL_PROMOTION_DENIED', '提交 Skill 晋升审核需要 high 身份与 skill:propose capability');
  }
  if (!/^[0-9a-f]{8}$/.test(String(contentId ?? ''))) fail('SKILL_CONTENT_ID_INVALID', 'content_id 必须是 8 位小写十六进制');
  if (!/^[0-9a-f]{64}$/.test(String(revision ?? ''))) fail('SKILL_REVISION_INVALID', 'revision 必须是 skill_inspect 返回的 64 位 tree hash');
  const done = completedPromotion(instanceDir, { name, content_id: contentId, revision });
  if (done) return { already_promoted: true, created: false, ...done.current, audit: done.record };
  const current = inspectSkillDirectory(instanceDir, name);
  if (current.content_id !== contentId || current.revision !== revision) {
    fail('SKILL_STALE_REVISION', `待审版本已变化：当前 content_id=${current.content_id} revision=${current.revision}`);
  }
  if (existsSync(path.join(instanceDir, current.target))) fail('SKILL_TARGET_EXISTS', `正式 Skill 已存在：${current.target}（默认禁止覆盖）`);

  for (const item of inbox.listEntries().entries) {
    if (item.kind !== 'skill' || !['held', 'pending'].includes(item.status)) continue;
    const raw = readFileSync(path.join(instanceDir, item.path), 'utf8');
    const payload = parseSkillPromotionProposal({ raw });
    if (payload?.name === name && payload.content_id === contentId && payload.revision === revision) {
      return { id: item.id, path: item.path, status: item.status, created: false, already_pending: true, ...current };
    }
  }

  const payload = {
    version: 1,
    name,
    content_id: contentId,
    revision,
    source: current.source,
    target: current.target,
    admission: current.manifest.admission,
    risk_level: current.manifest.riskLevel,
    file_count: current.file_count,
    total_bytes: current.total_bytes,
  };
  const caps = current.manifest.capabilities.slice(0, 20).join(', ') || `(${current.manifest.capabilitiesStatus})`;
  const content = [
    `Skill 晋升审核：${name}`,
    `版本：content_id=${contentId} revision=${revision}`,
    `目录：${current.source} → ${current.target}`,
    `资源：${current.file_count} files / ${current.total_bytes} bytes`,
    `能力：${caps}${current.manifest.capabilities.length > 20 ? '…' : ''}`,
    `准入：${current.manifest.admission}（${current.manifest.admissionReason}）`,
    '',
    '```json',
    JSON.stringify(payload),
    '```',
  ].join('\n');
  if (content.length > INBOX_PREVIEW_CHARS) fail('SKILL_REVIEW_TOO_LARGE', 'Skill 晋升审核摘要超过 owner 可见预览上限');
  const optionsBlock = { options: [
    {
      label: '✅ 批准晋升此版本',
      decision: {
        disposition: 'canonical', action: 'promote_skill', zone: 'skills', target: name,
        content_id: contentId, revision, summary: `晋升 Skill ${name}`, confidence: 1,
      },
    },
    {
      label: '拒绝晋升（保留 _incoming 供修改）',
      decision: { disposition: 'forbidden', reject_reason: `主人拒绝晋升 Skill ${name}；候选保留在 _incoming` },
    },
  ] };
  const receipt = inbox.addEntry({ kind: 'skill', content, client, admission, status: 'held', optionsBlock });
  return { ...receipt, created: true, ...current };
}

export function validateSkillPromotionDecision({ instanceDir, entry, decision }) {
  if (entry?.kind !== 'skill') return { ok: false, holdClass: 'security', reason: '[SKILL_PROMOTION_DENIED] promote_skill 只接受 kind=skill 的服务端审核件' };
  if (!entry.__native || !entry.__ruling_authentic || entry.__ruling_trust !== 'high' || entry.__ruling_channel !== 'primary') {
    return { ok: false, holdClass: 'security', reason: '[SKILL_PROMOTION_DENIED] Skill 晋升须由高信任主频道 owner 点选批准，且审核件内容绑定校验通过' };
  }
  const proposal = parseSkillPromotionProposal(entry);
  if (!proposal) return { ok: false, holdClass: 'security', reason: '[SKILL_PROMOTION_DENIED] Skill 审核件的 owner 可见 payload 无效或超出预览窗口' };
  if (decision.target !== proposal.name || decision.content_id !== proposal.content_id || decision.revision !== proposal.revision) {
    return { ok: false, holdClass: 'security', reason: '[SKILL_PROMOTION_DENIED] promote_skill 隐藏决定与 owner 可见审核对象不一致' };
  }
  const done = completedPromotion(instanceDir, { ...proposal, receipt_id: entry.id });
  if (done) return { ok: true, idempotent: true, proposal, inspection: done.current };
  try {
    const current = inspectSkillDirectory(instanceDir, proposal.name);
    if (current.content_id !== proposal.content_id || current.revision !== proposal.revision) {
      return { ok: false, holdClass: 'owner', reason: `[SKILL_STALE_REVISION] 批准绑定的 Skill 版本已过期；当前 revision=${current.revision}，请重新提交审核` };
    }
    if (existsSync(path.join(instanceDir, proposal.target))) {
      return { ok: false, holdClass: 'security', reason: `[SKILL_TARGET_EXISTS] 正式目标已存在，默认禁止覆盖：${proposal.target}` };
    }
    return { ok: true, proposal, inspection: current };
  } catch (e) {
    return { ok: false, holdClass: e.code === 'SKILL_NOT_FOUND' ? 'owner' : 'security', reason: e.message };
  }
}

export function applySkillPromotion({ instanceDir, entry, decision }) {
  const checked = validateSkillPromotionDecision({ instanceDir, entry, decision });
  if (!checked.ok) fail('SKILL_PROMOTION_DENIED', checked.reason);
  if (checked.idempotent) {
    return { changedPaths: [], detail: `${checked.proposal.target} 已按同一 approval receipt 晋升（幂等）`, idempotent: true };
  }
  const { proposal } = checked;
  const sourceAbs = path.join(instanceDir, proposal.source);
  const targetAbs = path.join(instanceDir, proposal.target);
  const auditAbs = path.join(instanceDir, PROMOTION_AUDIT_REL);
  const auditExisted = existsSync(auditAbs);
  const auditBefore = auditExisted ? readFileSync(auditAbs, 'utf8') : '';
  const token = randomBytes(16).toString('hex');
  const record = {
    version: 1,
    receipt_id: entry.id,
    name: proposal.name,
    content_id: proposal.content_id,
    revision: proposal.revision,
    approved_by: oneline(entry.__ruling_via) || 'unknown-primary-owner',
    approval_channel: entry.__ruling_channel,
    approved_at: entry.__ruling_at ?? new Date().toISOString(),
    source: proposal.source,
    target: proposal.target,
    completed_at: new Date().toISOString(),
    result: 'promoted',
  };
  mkdirSync(path.dirname(targetAbs), { recursive: true });
  mkdirSync(path.dirname(auditAbs), { recursive: true });
  try {
    renameSync(sourceAbs, targetAbs); // 同一实例 worktree 内的目录 rename：原子切换，不留下半棵正式目录。
    appendFileSync(auditAbs, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    pendingPromotionRollbacks.set(token, {
      instanceDir: path.resolve(instanceDir), sourceAbs, targetAbs, auditAbs, auditExisted, auditBefore,
    });
  } catch (e) {
    try { if (existsSync(targetAbs) && !existsSync(sourceAbs)) renameSync(targetAbs, sourceAbs); } catch { /* 外层仍 fail closed */ }
    try {
      if (auditExisted) writeFileSync(auditAbs, auditBefore);
      else if (existsSync(auditAbs)) unlinkSync(auditAbs);
    } catch { /* 外层回滚再处理 git diff */ }
    throw e;
  }
  return {
    changedPaths: [proposal.source.replace(/\/$/, ''), proposal.target.replace(/\/$/, ''), PROMOTION_AUDIT_REL],
    detail: proposal.target,
    rollbackSkillToken: token,
    promotionRecord: record,
  };
}

export function rollbackSkillPromotion({ instanceDir, rollbackToken }) {
  const state = pendingPromotionRollbacks.get(rollbackToken);
  if (!state || state.instanceDir !== path.resolve(instanceDir)) fail('SKILL_ROLLBACK_INVALID', 'Skill 晋升回滚 token 无效或已消费');
  pendingPromotionRollbacks.delete(rollbackToken);
  if (existsSync(state.targetAbs) && !existsSync(state.sourceAbs)) renameSync(state.targetAbs, state.sourceAbs);
  if (state.auditExisted) writeFileSync(state.auditAbs, state.auditBefore);
  else if (existsSync(state.auditAbs)) unlinkSync(state.auditAbs);
  // rename 后可能留下空的 skills/<name> 父目录之外目录；target 本身已不存在。防御性清理仅限明确 target。
  if (existsSync(state.targetAbs)) rmSync(state.targetAbs, { recursive: true, force: true });
}

export function finalizeSkillPromotion(rollbackToken) {
  if (rollbackToken) pendingPromotionRollbacks.delete(rollbackToken);
}
