// Explicit removal requests are signed data. Models never choose their targets.
import { lstatSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseZones } from './acl.js';
import { containsCredential } from './secrets.js';
import { findTodoMatches } from './todo.js';
import { inspectCollectionRemoval, applyCollectionRemoval } from './collection-removal.js';

const KINDS = new Set(['remove', 'todo_remove', 'collection_remove']);
const FORBIDDEN_ZONES = new Set(['governance', 'skills', 'inbox', 'keeper-feedback', 'todo', 'collections']);
const CONFIG = {
  remove: { action: 'remove_page', capability: 'page:remove' },
  todo_remove: { action: 'todo_remove', capability: 'todo:remove' },
  collection_remove: { action: 'remove_rows', capability: 'collection:remove' },
};

function checked(kind, value) {
  if (!KINDS.has(kind) || !value || value.removal_request !== 1) throw new Error('无效的专用移除请求');
  const allowed = ['removal_request', 'reason', ...(kind === 'remove' ? ['path'] : kind === 'todo_remove' ? ['item'] : ['collection', 'ids'])];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('移除请求包含未知字段');
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 4000)) throw new Error('移除原因过长或格式无效');
  const text = [value.path, value.item, value.collection, ...(Array.isArray(value.ids) ? value.ids : []), value.reason].filter(v => typeof v === 'string').join('\n');
  if (containsCredential(text)) throw new Error('拒收：移除请求含疑似凭据');
  if (kind === 'remove') {
    if (typeof value.path !== 'string' || value.path.length > 1000 || !value.path.endsWith('.md')
        || value.path.startsWith('/') || /[\\\s\u0000-\u001f\u007f]/u.test(value.path)
        || value.path.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git' || !/^[\w.一-鿿-]+$/u.test(s)) || !value.path.includes('/')) {
      throw new Error('删除页面请提供规范的实例内 .md 路径');
    }
  } else if (kind === 'todo_remove') {
    if (typeof value.item !== 'string' || !value.item.trim() || value.item.length > 4000 || /[\r\n\u0085\u2028\u2029]/u.test(value.item)) {
      throw new Error('移除待办请提供完整条目首行');
    }
  } else {
    if (typeof value.collection !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value.collection)
        || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 200
        || value.ids.some(id => typeof id !== 'string' || !id || id !== id.trim() || id.length > 200 || /[\p{Cc}\u2028\u2029]/u.test(id))
        || new Set(value.ids).size !== value.ids.length) throw new Error('收藏删除须提供收藏名和 1–200 个不重复的精确行 ID');
  }
  return value;
}

export function encodeRemovalRequest(kind, value) {
  const checkedValue = checked(kind, { removal_request: 1, ...value });
  return '```json\n' + JSON.stringify(checkedValue).replace(/</g, '\\u003c') + '\n```';
}

export function readRemovalRequest(entry) {
  if (!KINDS.has(entry?.kind)) return null;
  const body = String(entry.body ?? '').trim();
  const json = body.match(/^```json\n([\s\S]*)\n```$/);
  if (json) {
    let value;
    try { value = JSON.parse(json[1]); } catch { throw new Error('移除请求 JSON 无效'); }
    return checked(entry.kind, value);
  }
  if (entry.kind !== 'remove') throw new Error('请通过专用待办/收藏移除工具提交');
  // Only an entire literal path plus an optional parenthesized explanation;
  // never pluck a path out of arbitrary prose, quotes, or an instruction block.
  const literal = body.match(/^([a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.md)(?:[（(]([^\r\n]*)[）)])?$/);
  return literal ? checked('remove', { removal_request: 1, path: literal[1], ...(literal[2] ? { reason: literal[2] } : {}) }) : null;
}

function regularPath(instanceDir, rel) {
  let abs = path.resolve(instanceDir);
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const names = readdirSync(abs);
    if (!names.includes(parts[i])) {
      if (names.some(name => name.toLowerCase() === parts[i].toLowerCase())) throw new Error('移除路径大小写必须与实际文件完全一致');
      return false;
    }
    abs = path.join(abs, parts[i]);
    let stat;
    try { stat = lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('移除目标路径必须是实例内普通文件，不能经过符号链接');
  }
  return true;
}

export function inspectPageRemoval(instanceDir, rel) {
  checked('remove', { removal_request: 1, path: rel });
  const zones = parseZones(instanceDir).filter(z => z.path && rel.startsWith(z.path.endsWith('/') ? z.path : z.path + '/'));
  const zone = zones.sort((a, b) => b.path.length - a.path.length)[0];
  const base = path.posix.basename(rel);
  if (!zone || FORBIDDEN_ZONES.has(zone.id) || ['governance', 'skills', 'inbox', 'keeper-feedback', 'todo', 'collections'].includes(rel.split('/')[0])
      || base.toLowerCase() === 'readme.md' || base.startsWith('_')) throw new Error('不能删除结构页或待办/收藏整页；请使用 todo_remove 或 collections_remove 处理条目');
  return { zone, exists: regularPath(instanceDir, rel) };
}

function inspectTodoRemoval(instanceDir, item) {
  const hit = findTodoMatches(instanceDir, item, { exactOnly: true, literal: /^(?:\d+\.|[-*])\s+/.test(item.trim()) });
  if (hit.matches.length > 1) throw new Error('移除待办必须唯一匹配完整条目；请从 todo_list 复制首行，保留编号或完成日期');
  return hit;
}

export function removalDecision(instanceDir, entry, request) {
  const action = CONFIG[entry.kind].action;
  const zone = entry.kind === 'remove'
    ? parseZones(instanceDir).filter(z => z.path && request.path.startsWith(z.path.endsWith('/') ? z.path : z.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]?.id
    : entry.kind === 'todo_remove' ? 'todo' : 'collections';
  return { disposition: 'canonical', tier: 'canonical', confidence: 1, action, zone,
    target: request.path ?? request.item ?? request.collection,
    summary: entry.kind === 'todo_remove' ? '已移除指定待办及其备注，未将其标为完成' : entry.kind === 'collection_remove' ? '已按精确 ID 处理指定收藏行' : '已处理指定页面删除请求',
  };
}

export function validateRemovalDecision(instanceDir, entry, decision, request) {
  const cfg = CONFIG[entry.kind];
  if (!entry.__native || !cfg || !entry.__capabilities?.includes(cfg.capability)) return { ok: false, holdClass: 'security', reason: '移除只接受具有对应权限的已认证专用请求' };
  if (entry.__ruling_authentic && entry.__ruling_trust !== 'high') return { ok: false, holdClass: 'security', reason: '移除请求只能由高信任通道重新裁定执行' };
  if (decision.disposition !== 'canonical' || (decision.tier != null && decision.tier !== 'canonical') || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1 || !decision.summary) return { ok: false, holdClass: 'security', reason: '移除决定缺少合法类型或摘要' };
  const expected = removalDecision(instanceDir, entry, request);
  if (decision.action !== expected.action || decision.target !== expected.target || decision.zone !== expected.zone || decision.operations) return { ok: false, holdClass: 'security', reason: '移除动作和目标必须与原始请求完全一致，不能由模型或裁定改写' };
  try {
    if (entry.kind === 'remove') inspectPageRemoval(instanceDir, request.path);
    else if (entry.kind === 'todo_remove') inspectTodoRemoval(instanceDir, request.item);
    else inspectCollectionRemoval(instanceDir, request.collection, request.ids);
  } catch (e) { return { ok: false, holdClass: 'owner', reason: e.message }; }
  return { ok: true, verdict: 'file', zone: parseZones(instanceDir).find(z => z.id === expected.zone) };
}

export function applyTypedRemoval(instanceDir, entry, decision) {
  const request = readRemovalRequest(entry);
  if (!request) throw new Error('移除请求缺少绑定目标');
  const check = validateRemovalDecision(instanceDir, entry, decision, request);
  if (!check.ok) throw new Error(check.reason);
  if (entry.kind === 'collection_remove') return applyCollectionRemoval(instanceDir, request.collection, request.ids);
  if (entry.kind !== 'todo_remove') throw new Error('页面删除必须经过 curator');
  const hit = inspectTodoRemoval(instanceDir, request.item);
  if (!hit.matches.length) return { changedPaths: [], detail: '指定待办已不存在，未作修改' };
  const { i, end } = hit.matches[0];
  hit.lines.splice(i, end - i);
  const after = hit.lines.join('\n').replace(/^updated: .*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(path.join(instanceDir, hit.rel), after);
  return { changedPaths: [hit.rel], detail: `已移除待办：${hit.needle.slice(0, 80)}` };
}
