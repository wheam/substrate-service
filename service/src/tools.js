// 五个读工具的实现（M1）。全部只读实例工作副本；trust 缺省按最低处理。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseZones, canRead } from './acl.js';

const SEARCH_EXTS = new Set(['.md', '.csv', '.txt']);
const MAX_RESULTS = 50;
const MAX_SNIPPET = 200;
const MAX_FIELD = 400;

export function createTools({ instanceDir }) {
  const zones = () => parseZones(instanceDir); // 每次现读：git pull 可能更新 zones.md

  function safeResolve(relPath) {
    if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)) {
      throw new Error(`非法路径：${relPath}（只接受实例内相对路径）`);
    }
    const abs = path.resolve(instanceDir, relPath);
    const rel = path.relative(instanceDir, abs);
    if (rel.startsWith('..') || rel === '' || rel.split(path.sep)[0] === '.git') {
      throw new Error(`非法路径：${relPath}（越界或指向 .git）`);
    }
    return { abs, rel: rel.split(path.sep).join('/') };
  }

  function walkFiles() {
    const out = [];
    const stack = [''];
    while (stack.length) {
      const dir = stack.pop();
      for (const name of readdirSync(path.join(instanceDir, dir))) {
        if (name === '.git' || name === 'node_modules') continue;
        const rel = dir ? `${dir}/${name}` : name;
        const st = statSync(path.join(instanceDir, rel));
        if (st.isDirectory()) stack.push(rel);
        else if (SEARCH_EXTS.has(path.extname(name))) out.push(rel);
      }
    }
    return out;
  }

  async function search({ query, zone, trust = 'low' }) {
    if (!query?.trim()) return { results: [] };
    const zs = zones();
    const zoneDef = zone ? zs.find((z) => z.id === zone) : null;
    if (zone && !zoneDef) {
      throw new Error(`没有叫 ${zone} 的分区，可用：${zs.map((z) => z.id).join('、')}`);
    }
    const needle = query.toLowerCase();
    const results = [];
    for (const rel of walkFiles()) {
      if (zoneDef && !rel.startsWith(zoneDef.path)) continue;
      if (!canRead(zs, rel, trust)) continue;
      const lines = readFileSync(path.join(instanceDir, rel), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ path: rel, line: i + 1, snippet: lines[i].trim().slice(0, MAX_SNIPPET) });
          if (results.length >= MAX_RESULTS) return { results, truncated: true };
        }
      }
    }
    return { results };
  }

  async function readPage({ path: relPath, trust = 'low' }) {
    const { abs, rel } = safeResolve(relPath);
    if (!canRead(zones(), rel, trust)) {
      throw new Error(`拒绝：${rel} 属于 sensitive 敏感分区，当前客户端信任级不足`);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`没有这个文件：${rel}`);
    return { path: rel, content: readFileSync(abs, 'utf8') };
  }

  async function getContext({ trust = 'low' }) {
    // 常驻上下文内嵌 about-owner 核心（sensitive），与 memory 区同级把关
    if (trust !== 'high') throw new Error('拒绝：常驻上下文含 sensitive 敏感记忆，当前客户端信任级不足');
    const script = path.join(instanceDir, 'skills', 'substrate-runtime-context', 'render-context.py');
    const content = await new Promise((resolve, reject) => {
      execFile('python3', [script], { cwd: instanceDir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(`render-context 失败：${stderr || err.message}`)) : resolve(stdout)));
    });
    return { content };
  }

  async function todoList() {
    return { content: readFileSync(path.join(instanceDir, 'todo', 'owner.md'), 'utf8') };
  }

  async function collectionsSearch({ name, query }) {
    const csvPath = path.join(instanceDir, 'collections', name ?? '', 'data.csv');
    if (!name || name.includes('/') || name.includes('..') || !existsSync(csvPath)) {
      const available = existsSync(path.join(instanceDir, 'collections'))
        ? readdirSync(path.join(instanceDir, 'collections')).filter((d) =>
            existsSync(path.join(instanceDir, 'collections', d, 'data.csv')))
        : [];
      throw new Error(`没有叫 ${name} 的收藏，可用：${available.join('、') || '（无）'}`);
    }
    const records = parseCsv(readFileSync(csvPath, 'utf8'));
    const [header, ...dataRows] = records;
    const needle = (query ?? '').trim().toLowerCase();
    const rows = dataRows
      .filter((r) => !needle || r.some((v) => v.toLowerCase().includes(needle)))
      .slice(0, MAX_RESULTS)
      .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').slice(0, MAX_FIELD)])));
    return { name, columns: header, rows, total: dataRows.length };
  }

  return { search, readPage, getContext, todoList, collectionsSearch };
}

// 最小 RFC4180 解析：引号字段、双引号转义、引号内换行
function parseCsv(text) {
  const records = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  return records;
}
