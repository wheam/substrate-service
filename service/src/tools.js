// 五个读工具的实现（M1）。全部只读实例工作副本；trust 缺省按最低处理。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseZones, canRead, zoneFor } from './acl.js';
import { readTier, normalizeInclude, isQuarantineRejected } from './tier.js';

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

  async function search({ query, zone, trust = 'low', include }) {
    if (!query?.trim()) return { results: [] };
    const zs = zones();
    const zoneDef = zone ? zs.find((z) => z.id === zone) : null;
    if (zone && !zoneDef) {
      throw new Error(`没有叫 ${zone} 的分区，可用：${zs.map((z) => z.id).join('、')}`);
    }
    // 分层过滤（§6.3）：默认只返 canonical；include 显式开 candidate/rejected（与 index/recall 同口径）。
    const wantTiers = new Set(['canonical', ...normalizeInclude(include)]);
    // 缺陷1：search 只扫【注册 zone】。唯一例外 = inbox 隔离-rejected 件（status:rejected + tier:rejected），
    // 且 include 含 rejected、高信任、未限定其它 zone——与 index 侧特例完全同构（共用 isQuarantineRejected）。
    // 故 governance/skills/keeper-feedback、以及 inbox 的 pending/held 待判件从 search 彻底消失：高信任
    // 【默认档】也扫不到隔离待判件，兑现「pending/held 任何档任何组合绝不可查」的不变式。
    // （readPage/getContext 是另一条通路、各自把关，不受本收紧影响。）
    const allowInboxRejected = wantTiers.has('rejected') && trust === 'high' && !zoneDef;
    const needle = query.toLowerCase();
    const results = [];
    for (const rel of walkFiles()) {
      if (zoneDef && !rel.startsWith(zoneDef.path)) continue;
      const registered = !!zoneFor(zs, rel);
      if (registered) {
        if (!canRead(zs, rel, trust)) continue;
      } else if (!(allowInboxRejected && rel.startsWith('inbox/'))) {
        continue; // 未注册路径：除 inbox 隔离-rejected 窄例外，一律不扫
      }
      const text = readFileSync(path.join(instanceDir, rel), 'utf8');
      // 未注册的 inbox 件必须过隔离-rejected 双条件（pending/held、手写残留一律挡在外面）。
      if (!registered && !isQuarantineRejected(text)) continue;
      // tier 从 frontmatter 读（无 → canonical）；不在请求档内的页整页跳过（candidate/rejected 默认不现）。
      const tier = rel.endsWith('.md') ? readTier(text) : 'canonical';
      if (!wantTiers.has(tier)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ path: rel, line: i + 1, tier, snippet: lines[i].trim().slice(0, MAX_SNIPPET) });
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

  async function todoList({ list } = {}) {
    const dir = path.join(instanceDir, 'todo');
    const available = readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_'))
      .map((f) => f.replace(/\.md$/, ''));
    const wanted = list?.trim();
    const stem = !wanted
      ? 'owner'
      : available.find((a) => a === wanted)
        ?? available.find((a) => a === `${wanted}-todo`)
        ?? available.find((a) => a.startsWith(wanted));
    if (!stem || !available.includes(stem)) {
      throw new Error(`没有叫 ${wanted} 的待办清单，可用：${available.join('、')}`);
    }
    return {
      list: stem,
      content: readFileSync(path.join(dir, `${stem}.md`), 'utf8'),
      other_lists: available.filter((a) => a !== stem),
    };
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
