// 检索索引（派生、可抛）：SQLite FTS5，node:sqlite 内置——零第三方依赖。
//
// 铁律（spec §6.4）：索引不持有任何独有正典——一切从实例文件重建。索引文件放实例 git 仓库【之外】
// （env INDEX_PATH，默认落实例目录父级 = 服务 DATA_DIR），删掉 → 下次调用自动重建。
//
// 中文检索：trigram 分词器对 <3 字符查询/中文两字词全落空（已实测，弃用）。改用 unicode61 +
// 索引侧与查询侧【同一套】CJK bigram 预切分（连续 CJK run 切相邻两字对：「旧金山牛排」→「旧金 金山
// 山牛 牛排」；ASCII 词原样小写）。实测「牛排」「旧金山」「wagyu」全命中。单字 CJK 查询 bigram 索引
// 里无对应 token → 降级走 raw 列子串扫描（见 query()）。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseZones, canRead, canReadZone, zoneFor } from './acl.js';
import { readContentId } from './content-id.js';

const SEARCH_EXTS = new Set(['.md', '.csv', '.txt']);
const MAX_RESULTS = 50;
const MAX_SNIPPET = 200;
const MAX_RAW = 500;

// CJK（含日文假名、韩文谚文）。bigram 预切分索引侧/查询侧共用，保证一致。
const CJK_RE = /[\p{Script=Han}぀-ヿ가-힯]/u;
const TOKEN_RE = /[\p{Script=Han}぀-ヿ가-힯]+|[A-Za-z0-9_]+/gu;

// 文本 → 检索 token 序列：CJK run 切 bigram（单字 run 保留单字，供降级判定），ASCII 词小写原样。
export function cjkTokens(text) {
  const out = [];
  for (const tok of String(text).match(TOKEN_RE) ?? []) {
    if (CJK_RE.test(tok[0])) {
      if (tok.length === 1) out.push(tok);
      else for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
    } else {
      out.push(tok.toLowerCase());
    }
  }
  return out;
}
const preprocess = (text) => cjkTokens(text).join(' ');

function defaultIndexPath(instanceDir) {
  if (process.env.INDEX_PATH) return process.env.INDEX_PATH;
  // 实例目录的父级 = 服务 DATA_DIR（如 /data/instance → /data/recall-index.sqlite）：
  // 绝不落进实例 git 工作树被整树提交。
  return path.join(path.dirname(path.resolve(instanceDir)), 'recall-index.sqlite');
}

// 解析 p 的真实路径：对已存在的最深祖先做 realpath（解析符号链接），再拼回尚不存在的尾部。
function realResolve(p) {
  let abs = path.resolve(p);
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const base = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? path.join(base, ...tail) : base;
}

// 红线（spec §6.4 / §2）：索引文件绝不能落进实例 git 工作树（否则被整树提交，主权/离线副本被污染）。
// 除 :memory: 外，dbPath（realpath）落在 instanceDir（realpath）之内直接抛错拒绝——env INDEX_PATH 亦然。
function assertIndexOutsideInstance(dbPath, instanceDir) {
  if (dbPath === ':memory:' || !instanceDir) return;
  const db = realResolve(dbPath);
  const inst = realResolve(instanceDir);
  if (db === inst || db.startsWith(inst + path.sep)) {
    throw new Error(`红线：索引文件不得落在实例 git 工作树内（${dbPath} ⊂ ${instanceDir}）——请把 INDEX_PATH 指到实例目录之外`);
  }
}

export function createIndexStore({ instanceDir, indexPath } = {}) {
  const dbPath = indexPath ?? defaultIndexPath(instanceDir);
  assertIndexOutsideInstance(dbPath, instanceDir);
  let db = null;
  let generation = 0; // 索引换代计数：每次结构性变更（重建/增量/删）+1，供上层缓存（recall）据此失效

  function connect() {
    if (db) return db;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    return db;
  }

  // 索引是否已建（表在且有行）——缺表/空表/文件被删后新开的空库都算「未建」→ 触发重建。
  function hasIndex() {
    // 缺陷4：文件被 unlink 后，已打开的连接 fd 仍活、SQLite 照常读写这个「不存在的文件」，
    // 永不重建（违背「删索引任何时刻可重建」铁律）。先探物理文件：不在（:memory: 除外）就
    // 关掉悬空连接、判为「未建」→ 触发 rebuild 时 connect() 会新建出文件。
    if (dbPath !== ':memory:' && !existsSync(dbPath)) {
      if (db) { try { db.close(); } catch { /* 忽略 */ } db = null; }
      return false;
    }
    try {
      const d = connect();
      const t = d.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='docs'`).get();
      if (!t?.n) return false;
      return (d.prepare(`SELECT count(*) AS n FROM docs`).get()?.n ?? 0) > 0;
    } catch { return false; }
  }

  // 缺陷1（治理边界）：只索引「注册 zone」（parseZones 的 path 前缀之内）的路径。
  // inbox/（隔离件）、keeper-feedback/、governance/、skills/ 等未注册目录永不入索引——
  // 否则低/高信任 recall/查询会命中隔离件、把内容送进 LLM，破坏「隔离 inbox / governed promotion」边界。
  const inRegisteredZone = (zones, rel) => !!zoneFor(zones, rel);

  function ensureBuilt() {
    if (!hasIndex()) rebuild();
  }

  function walkFiles() {
    const out = [];
    const stack = [''];
    while (stack.length) {
      const dir = stack.pop();
      for (const name of readdirSync(path.join(instanceDir, dir))) {
        if (name === '.git' || name === 'node_modules') continue;
        const rel = dir ? `${dir}/${name}` : name;
        if (statSync(path.join(instanceDir, rel)).isDirectory()) stack.push(rel);
        else if (SEARCH_EXTS.has(path.extname(name))) out.push(rel);
      }
    }
    return out;
  }

  // 一个文件 → 逐行行（跳过空行/纯符号行）：raw 存原行供 snippet，body 存 bigram 预处理供 FTS。
  function rowsForFile(rel, zones) {
    const text = readFileSync(path.join(instanceDir, rel), 'utf8');
    const contentId = rel.endsWith('.md') ? readContentId(text) : null;
    const zone = zoneFor(zones, rel)?.id ?? null;
    const rows = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const body = preprocess(raw);
      if (!body) continue;
      rows.push([rel, contentId, zone, i + 1, raw.slice(0, MAX_RAW), body]);
    }
    return rows;
  }

  function createSchema(d) {
    d.exec(`DROP TABLE IF EXISTS docs;`);
    d.exec(`CREATE VIRTUAL TABLE docs USING fts5(
      path UNINDEXED, content_id UNINDEXED, zone UNINDEXED, lineno UNINDEXED, raw UNINDEXED, body,
      tokenize='unicode61'
    );`);
  }

  const INSERT = `INSERT INTO docs(path, content_id, zone, lineno, raw, body) VALUES (?,?,?,?,?,?)`;

  // 全量重建：幂等（DROP+CREATE 后从文件全灌）。fixture 规模秒级。只灌注册 zone 的文件（缺陷1）。
  function rebuild() {
    const d = connect();
    const zones = parseZones(instanceDir);
    createSchema(d);
    const ins = d.prepare(INSERT);
    d.exec('BEGIN');
    try {
      for (const rel of walkFiles()) {
        if (!inRegisteredZone(zones, rel)) continue; // 隔离/系统区永不入索引
        for (const r of rowsForFile(rel, zones)) ins.run(...r);
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    generation++;
    return { ok: true };
  }

  // 增量：单页更新（keeper 单写口每次归档后 / 直接编辑后调）。无索引先全建。
  function updatePage(rel) {
    if (!SEARCH_EXTS.has(path.extname(rel))) return;
    if (!hasIndex()) return void rebuild();
    const d = connect();
    const zones = parseZones(instanceDir);
    const indexable = inRegisteredZone(zones, rel); // 未注册 zone 的路径不入索引（缺陷1）
    d.exec('BEGIN');
    try {
      d.prepare('DELETE FROM docs WHERE path = ?').run(rel);
      if (indexable && existsSync(path.join(instanceDir, rel))) {
        const ins = d.prepare(INSERT);
        for (const r of rowsForFile(rel, zones)) ins.run(...r);
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    generation++;
  }

  function removePage(rel) {
    if (!hasIndex()) return;
    connect().prepare('DELETE FROM docs WHERE path = ?').run(rel);
    generation++;
  }

  // 查询：query（+可选 zone / trust）。过与现有 search 相同的 canRead ACL。返回 path/content_id/snippet/score(bm25)。
  function query({ query: q, zone, trust = 'low', limit = MAX_RESULTS } = {}) {
    if (!q?.trim()) return { results: [] };
    ensureBuilt();
    const d = connect();
    const zones = parseZones(instanceDir);
    const zoneDef = zone ? zones.find((z) => z.id === zone) : null;
    if (zone && !zoneDef) {
      throw new Error(`没有叫 ${zone} 的分区，可用：${zones.map((z) => z.id).join('、')}`);
    }
    // 缺陷8：把「按 trust 可读的 zone 集合」预过滤进 SQL（zone IN (...)），令 ACL 在 LIMIT 之前生效——
    // 否则敏感命中多时，over 行全被敏感占满、JS 事后过滤把可读结果挤掉，低信任假落空。
    // 索引里只有注册 zone 的行（缺陷1），故按 zone id 精确圈定即可。
    let allowedZones = zones.filter((z) => canReadZone(z, trust)).map((z) => z.id);
    if (zoneDef) allowedZones = allowedZones.filter((id) => id === zoneDef.id);
    if (allowedZones.length === 0) return { results: [] };
    const zoneIn = `zone IN (${allowedZones.map(() => '?').join(',')})`;

    const toks = cjkTokens(q);
    // bigram 索引里没有单字 CJK token → 从 MATCH 里剔除；若全是单字 CJK，整体降级子串扫描。
    const usable = toks.filter((t) => !(t.length === 1 && CJK_RE.test(t)));
    const over = Math.max(limit * 4, limit); // 多取些，留给去重/截断（ACL 已在 SQL 里生效）
    let rows;
    if (usable.length === 0) {
      const singles = toks.filter(Boolean);
      if (!singles.length) return { results: [] };
      const where = singles.map(() => 'raw LIKE ?').join(' AND ');
      rows = d.prepare(`SELECT path, content_id, zone, lineno, raw, 0 AS score FROM docs WHERE ${zoneIn} AND ${where} LIMIT ?`)
        .all(...allowedZones, ...singles.map((s) => `%${s}%`), over);
    } else {
      const match = usable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '); // 引号护体 + 空格=AND
      try {
        rows = d.prepare(
          `SELECT path, content_id, zone, lineno, raw, bm25(docs) AS score FROM docs WHERE docs MATCH ? AND ${zoneIn} ORDER BY score LIMIT ?`
        ).all(match, ...allowedZones, over);
      } catch { rows = []; } // 畸形 MATCH 不崩，返回空
    }
    const results = [];
    for (const r of rows) {
      if (zoneDef && !r.path.startsWith(zoneDef.path)) continue;
      if (!canRead(zones, r.path, trust)) continue; // 纵深防御：SQL 已圈定，这里双保险
      results.push({
        path: r.path,
        content_id: r.content_id ?? null,
        zone: r.zone ?? null,
        line: r.lineno,
        snippet: r.raw.slice(0, MAX_SNIPPET),
        score: r.score,
      });
      if (results.length >= limit) break;
    }
    return { results };
  }

  function close() { if (db) { try { db.close(); } catch { /* 已关/文件已删，忽略 */ } db = null; } }

  return { rebuild, ensureBuilt, updatePage, removePage, query, close, dbPath, cjkTokens, generation: () => generation };
}
