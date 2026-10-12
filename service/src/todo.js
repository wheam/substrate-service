// Bounded task operations. Request content is signed in the existing native
// envelope; neither a model decision nor a generic save supplies note text.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { containsCredential } from './secrets.js';
import { scanSegments } from './inbox.js';

export const TODO_ITEM_LIMIT = 4000;
export const TODO_NOTE_LIMIT = 16000;
const REL = 'todo/owner.md';
const today = () => new Date().toISOString().slice(0, 10);

function checkedRequest(value, kind) {
  if (!value || value.todo_request !== 1 || typeof value.item !== 'string'
      || !value.item.trim() || value.item.length > TODO_ITEM_LIMIT
      || typeof value.note !== 'string' || !value.note.trim() || value.note.length > TODO_NOTE_LIMIT
      || Object.keys(value).some((key) => !['todo_request', 'item', 'note'].includes(key))
      || !['todo_done', 'todo_note'].includes(kind)) {
    throw new Error('待办备注请求无效：请提供条目原文和非空备注');
  }
  if (containsCredential(`${value.item}\n${value.note}`)) throw new Error('拒收：待办或备注含疑似凭据');
  return { item: value.item.trim(), note: value.note.replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n').trim() };
}

export function encodeTodoRequest({ item, note }, kind) {
  const request = checkedRequest({ todo_request: 1, item, note }, kind);
  if (kind === 'todo_done') assertCompletionNote(request.note);
  // JSON escapes newlines, and escaping '<' keeps HTML/machine markers literal
  // through the inbox parser without losing any user text after JSON decoding.
  return '```json\n' + JSON.stringify({ todo_request: 1, ...request }).replace(/</g, '\\u003c') + '\n```';
}

function assertCompletionNote(note) {
  // Reject an explicit leading negation; do not attempt general semantic inference.
  if (/^(?:(?:不是|并非|不算)(?:已经?)?完成|(?:并|尚|还)?未完成|还?没有?完成|(?:不要|别|请勿|勿)(?:标(?:记)?(?:为|成)?|设(?:为|成)?)(?:已经?)?完成|not\s+(?:yet\s+)?(?:done|complete(?:d)?)|do\s+not\s+mark\s+(?:it\s+)?(?:as\s+)?(?:done|complete(?:d)?))(?=$|[\s\p{P}])/iu.test(note.trim())) {
    throw new Error('备注明确表示未完成，不能调用 todo_done；迁移/移除请用 todo_remove，只补说明请用 todo_note');
  }
}

export function readTodoRequest(entry) {
  if (!['todo_done', 'todo_note'].includes(entry?.kind)) return null;
  const match = String(entry.body ?? '').trim().match(/^```json\n([\s\S]*)\n```$/);
  if (!match) {
    if (entry.kind === 'todo_note') throw new Error('待办备注须通过 todo_note 专用入口提交');
    return null; // Legacy todo_done(item): keeper still resolves natural language.
  }
  let value;
  try { value = JSON.parse(match[1]); }
  catch { throw new Error('待办备注请求的 JSON 无效'); }
  return checkedRequest(value, entry.kind);
}

function title(text) {
  return String(text).trim().replace(/^(?:\d+\.|[-*])\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '').replace(/\s+✅\s+\d{4}-\d{2}-\d{2}\s*$/, '').trim();
}

export function findTodoMatches(instanceDir, target, { action, exactOnly = false, literal = false } = {}) {
  // Never follow a task file/directory symlink outside this instance.
  if (!lstatSync(path.join(instanceDir, 'todo')).isDirectory()
      || !lstatSync(path.join(instanceDir, REL)).isFile()) throw new Error('待办清单须为实例内的普通文件');
  const text = readFileSync(path.join(instanceDir, REL), 'utf8');
  const lines = text.split('\n');
  // Fenced examples and hidden comments are content, never actual task headers.
  const structural = scanSegments(text).map((segment) => {
    const part = text.slice(segment.start, segment.end);
    return segment.kind === 'text' ? part : part.replace(/[^\n]/g, ' ');
  }).join('').split('\n');
  const needle = title(target ?? '');
  const completedDate = String(target ?? '').match(/\s+✅\s+(\d{4}-\d{2}-\d{2})\s*$/)?.[1];
  const entries = [];
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^##?\s/.test(structural[i])) {
      section = structural[i].match(/^## (进行中|待办|已完成)/)?.[1] ?? null;
      continue;
    }
    if (!section || !/^(?:\d+\.|[-*])\s+\S/.test(structural[i])) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^[ \t]/.test(lines[end]))) end++;
    while (end > i + 1 && !lines[end - 1].trim()) end--;
    entries.push({ i, end, section, line: lines[i], itemText: title(lines[i]), completedDate: lines[i].match(/\s+✅\s+(\d{4}-\d{2}-\d{2})\s*$/)?.[1] });
  }
  const match = (items) => {
    const exact = needle ? items.filter((item) => item.itemText === needle) : [];
    return exact.length || exactOnly ? exact : needle ? items.filter((item) => item.itemText.includes(needle)) : [];
  };
  let matches;
  if (literal) matches = entries.filter(item => item.line === String(target).trim());
  else if (completedDate) matches = match(entries.filter(item => item.section === '已完成' && item.completedDate === completedDate));
  else if (action === 'todo_done') {
    matches = match(entries.filter(item => item.section !== '已完成'));
    if (!matches.length) matches = match(entries.filter(item => item.section === '已完成'));
  } else matches = match(entries);
  const completedHeading = structural.findIndex((line) => /^## 已完成/.test(line));
  return { rel: REL, text, lines, needle, matches, completedHeading };
}

export function validateTodoDecision(instanceDir, decision, entry) {
  let request;
  try { request = readTodoRequest(entry); }
  catch (e) { return { ok: false, holdClass: 'security', reason: e.message }; }
  if (request && (decision.action !== entry.kind || decision.target !== request.item)) {
    return { ok: false, holdClass: 'security', reason: '待办操作必须使用原请求指定的动作和条目，不能由模型改写' };
  }
  if (request && decision.action === 'todo_done') {
    try { assertCompletionNote(request.note); }
    catch (e) { return { ok: false, holdClass: 'owner', reason: e.message }; }
  }
  if (decision.action === 'todo_note' && (!request || entry?.kind !== 'todo_note' || !entry.__native)) {
    return { ok: false, holdClass: 'security', reason: '追加待办备注只接受已认证的 todo_note 专用请求' };
  }
  if (!String(decision.target ?? '').trim()) return { ok: false, holdClass: 'owner', reason: '请提供待办条目原文或唯一片段' };
  const hit = findTodoMatches(instanceDir, decision.target, { action: decision.action });
  if (hit.matches.length !== 1) return {
    ok: false, holdClass: 'owner',
    reason: `待办目标须唯一匹配，「${hit.needle}」命中 ${hit.matches.length} 条，请提供条目原文；本次未修改清单`,
  };
  return { ok: true };
}

function noteLines(note) {
  // Plain text notes cannot create tasks, headings, hidden HTML or wikilinks.
  return note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').split('\n').map((line) => `  > ${line}`);
}

function appendNote(block, note) {
  if (!note) return block;
  const rendered = noteLines(note);
  const existing = [...(block.join('\n') + '\n').matchAll(/^  > 备注（\d{4}-\d{2}-\d{2}）：\n((?:  >[^\n]*\n)*)/gm)];
  if (existing.some((match) => match[1] === rendered.join('\n') + '\n')) return block;
  return [...block, '', `  > 备注（${today()}）：`, ...rendered];
}

export function applyTodoDecision(instanceDir, entry, decision) {
  const check = validateTodoDecision(instanceDir, decision, entry);
  if (!check.ok) throw new Error(check.reason);
  const request = readTodoRequest(entry);
  const { rel, text, lines, matches, completedHeading } = findTodoMatches(instanceDir, decision.target, { action: decision.action });
  const item = matches[0];
  let block = appendNote(lines.slice(item.i, item.end), request?.note);
  const completing = decision.action === 'todo_done' && item.section !== '已完成';
  if (completing) {
    block[0] = `- ${item.itemText} ✅ ${today()}`;
    lines.splice(item.i, item.end - item.i);
    let heading = completedHeading;
    if (heading > item.i) heading -= item.end - item.i;
    if (heading === -1) {
      lines.push('', '## 已完成', '');
      heading = lines.length - 2;
    }
    lines.splice(heading + 1, 0, '', ...block, '');
  } else {
    lines.splice(item.i, item.end - item.i, ...block);
  }
  const after = lines.join('\n');
  if (after !== text) writeFileSync(path.join(instanceDir, rel), after.replace(/^updated: .*$/m, `updated: ${today()}`));
  return {
    changedPaths: after === text ? [] : [rel],
    detail: `${decision.action === 'todo_note' ? '待办备注已补充' : completing ? '待办已完成' : request?.note ? '已完成待办的备注已补充' : '待办已是完成状态'}：${item.itemText.slice(0, 40)}`,
  };
}
