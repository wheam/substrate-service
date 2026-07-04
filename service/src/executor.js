// keeper 的确定性执行器：LLM 只出决定，落盘永远走这里（直改文件或调实例 vendored 脚本）。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseZones } from './acl.js';

const DISPOSITIONS = new Set(['canonical', 'reference', 'local-only', 'forbidden']);
const ACTIONS = new Set(['new_page', 'merge_into', 'upsert_row', 'todo_add', 'remove_page', 'todo_done']);
// 骨架/流水区永久禁删（keeper 对 inbox 的清理走内部通路，不经 remove_page）
const NO_DELETE_ZONES = new Set(['governance', 'skills', 'inbox', 'keeper-feedback']);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function py(instanceDir, script, args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [script, ...args], { cwd: instanceDir, timeout: 60_000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(script)} 失败：${stderr || err.message}`)) : resolve(stdout)));
  });
}

function badTarget(target) {
  return !target || typeof target !== 'string' || path.isAbsolute(target) || target.split('/').some((s) => s === '..' || s === '.git');
}

// 决定合法性校验（代码层，模型说什么不算数）
export function validateDecision({ instanceDir, decision }) {
  const d = decision ?? {};
  if (!DISPOSITIONS.has(d.disposition)) return { ok: false, reason: `disposition 不合法：${d.disposition}` };
  if (d.disposition === 'forbidden') return { ok: true, verdict: 'reject', reason: d.reject_reason || '按宪法禁止入库' };
  if (d.disposition === 'local-only') return { ok: false, reason: 'local-only 在服务端无意义（无本地），需主人定夺' };
  if (!ACTIONS.has(d.action)) return { ok: false, reason: `action 不合法：${d.action}` };
  if (typeof d.confidence !== 'number' || !d.summary) return { ok: false, reason: '缺 confidence 或 summary' };

  const zones = parseZones(instanceDir);
  const zone = zones.find((z) => z.id === d.zone);
  if (!zone) return { ok: false, reason: `zone 不存在：${d.zone}（可用：${zones.map((z) => z.id).join('、')}）` };

  if (d.action === 'todo_add') {
    if (d.zone !== 'todo') return { ok: false, reason: 'todo_add 只能进 todo 区' };
  } else if (d.action === 'todo_done') {
    if (d.zone !== 'todo') return { ok: false, reason: 'todo_done 只能作用于 todo 区' };
    if (!d.target?.trim()) return { ok: false, reason: 'todo_done 缺 target（待办条目原文）' };
  } else if (d.action === 'remove_page') {
    if (NO_DELETE_ZONES.has(d.zone)) return { ok: false, reason: `禁删区：${d.zone}（骨架/流水区不允许经服务删除）` };
    if (badTarget(d.target)) return { ok: false, reason: `target 不合法：${d.target}` };
    const slug = d.target.replace(/\.md$/, '');
    const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
    if (path.basename(rel) === 'README.md' || path.basename(rel).startsWith('_')) {
      return { ok: false, reason: `不允许删结构页：${rel}` };
    }
    if (!existsSync(path.join(instanceDir, rel))) return { ok: false, reason: `目标页不存在：${rel}（不误删，需主人确认）` };
  } else if (d.action === 'upsert_row') {
    if (badTarget(d.target) || d.target.includes('/')) return { ok: false, reason: `收藏名不合法：${d.target}` };
    if (!existsSync(path.join(instanceDir, 'collections', d.target, 'data.csv'))) {
      return { ok: false, reason: `收藏不存在：${d.target}` };
    }
    if (!d.fields || typeof d.fields !== 'object') return { ok: false, reason: 'upsert_row 缺 fields' };
  } else {
    if (badTarget(d.target)) return { ok: false, reason: `target 不合法：${d.target}` };
  }
  return { ok: true, verdict: 'file', zone };
}

export async function applyDecision({ instanceDir, entry, decision, zone }) {
  switch (decision.action) {
    case 'todo_add': return todoAdd(instanceDir, entry);
    case 'todo_done': return todoDone(instanceDir, decision);
    case 'upsert_row': return upsertRow(instanceDir, decision);
    case 'new_page': return newPage(instanceDir, entry, decision, zone);
    case 'merge_into': return mergeInto(instanceDir, entry, decision, zone);
    case 'remove_page': return removePage(instanceDir, decision, zone);
    default: throw new Error(`未知 action：${decision.action}`);
  }
}

async function removePage(instanceDir, decision, zone) {
  const slug = decision.target.replace(/\.md$/, '');
  const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
    ['rm', '--instance', '.', '--page', rel, '--apply']);
  // rm 会清全库反向链接 + 重建索引，改动面不可预知 → 整树提交（写者串行，窗口内无并发写）
  return { changedPaths: ['.'], detail: rel };
}

function todoAdd(instanceDir, entry) {
  const rel = 'todo/owner.md';
  const abs = path.join(instanceDir, rel);
  const text = readFileSync(abs, 'utf8');
  const m = text.match(/^## 待办\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) throw new Error('todo/owner.md 里找不到「## 待办」小节');
  const section = m[1];
  const numbers = [...section.matchAll(/^(\d+)\./gm)].map((x) => Number(x[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const insertAt = m.index + m[0].length;
  const line = `${next}. ${entry.body.trim()}\n`;
  const glue = m[0].endsWith('\n\n') ? '' : '\n';
  writeFileSync(abs, text.slice(0, insertAt) + (m[0].endsWith('\n') ? '' : '\n') + line + glue + text.slice(insertAt));
  return { changedPaths: [rel], detail: `todo/owner.md 第 ${next} 条` };
}

// 有界改动：把「进行中/待办」里唯一匹配的一条挪进「已完成」（- 原文 ✅ 日期，实例既有格式）
function todoDone(instanceDir, decision) {
  const rel = 'todo/owner.md';
  const abs = path.join(instanceDir, rel);
  const text = readFileSync(abs, 'utf8');
  const needle = decision.target.trim();
  const lines = text.split('\n');
  const matches = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^## (进行中|待办)/.test(lines[i])) { inSection = true; continue; }
    if (/^## /.test(lines[i])) { inSection = false; continue; }
    if (!inSection) continue;
    const itemText = lines[i].replace(/^(\d+\.|-)\s+/, '').trim();
    if (itemText && (itemText === needle || itemText.includes(needle))) matches.push({ i, itemText });
  }
  if (matches.length !== 1) {
    throw new Error(`todo_done 目标须唯一匹配，「${needle}」命中 ${matches.length} 条——请主人指明是哪条`);
  }
  const { i, itemText } = matches[0];
  lines.splice(i, 1);
  let out = lines.join('\n');
  if (!/^## 已完成/m.test(out)) out = out.replace(/\n*$/, '\n\n## 已完成\n');
  out = out.replace(/^## 已完成\n/m, `## 已完成\n\n- ${itemText} ✅ ${today()}\n`)
    .replace(/\n{4,}/g, '\n\n\n');
  writeFileSync(abs, out.replace(/^updated: .*$/m, `updated: ${today()}`));
  return { changedPaths: [rel], detail: `todo 完成：${itemText.slice(0, 40)}` };
}

async function upsertRow(instanceDir, decision) {
  const fields = { ...decision.fields };
  if (!fields.id) fields.id = slugify(fields.name ?? `${decision.target}-${Date.now().toString(36)}`);
  if (!fields.added_date) fields.added_date = today();
  fields.updated_date = today();
  const csvRel = `collections/${decision.target}/data.csv`;
  const args = ['upsert', '--csv', csvRel, '--apply'];
  for (const [k, v] of Object.entries(fields)) args.push('--field', `${k}=${String(v).replace(/\n/g, ' ')}`);
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-collections', 'collections.py'), args);
  return { changedPaths: [csvRel], detail: `${decision.target} 行 ${fields.id}` };
}

async function newPage(instanceDir, entry, decision, zone) {
  const slug = decision.target.replace(/\.md$/, '');
  const rel = path.posix.join(zone.path, `${slug}.md`);
  const abs = path.join(instanceDir, rel);
  if (existsSync(abs)) throw new Error(`页已存在：${rel}（该用 merge_into）`);
  const fm = [
    '---',
    `title: ${(decision.title ?? slug).replace(/\n/g, ' ')}`,
    `created: ${today()}`,
    `updated: ${today()}`,
    `type: ${decision.page_type ?? zone.id}`,
    `sources: [inbox ${entry.id} via ${entry.client}]`,
    '---',
    '',
  ].join('\n');
  writeFileSync(abs, fm + entry.body.trim() + '\n');
  // 登记索引（reindex 会给新页入链，免成孤儿）
  const zoneDir = zone.path.replace(/\/$/, '');
  await py(instanceDir, path.join(instanceDir, 'skills', 'substrate-curator', 'curate.py'),
    ['reindex', '--instance', '.', '--dir', zoneDir, '--apply']);
  return { changedPaths: [rel, `${zoneDir}/README.md`], detail: rel };
}

function mergeInto(instanceDir, entry, decision, zone) {
  const slug = decision.target.replace(/\.md$/, '');
  const rel = slug.startsWith(zone.path) ? `${slug}.md` : path.posix.join(zone.path, `${slug}.md`);
  const abs = path.join(instanceDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`目标页不存在：${rel}`);
  let text = readFileSync(abs, 'utf8');
  text = text.replace(/^updated: .*$/m, `updated: ${today()}`);
  text += `\n\n---\n\n**${today()} keeper 归档**（inbox ${entry.id}，来自 ${entry.client}）：\n\n${entry.body.trim()}\n`;
  writeFileSync(abs, text);
  return { changedPaths: [rel], detail: rel };
}

function slugify(s) {
  const ascii = String(s).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii || `item-${Date.now().toString(36)}`;
}
