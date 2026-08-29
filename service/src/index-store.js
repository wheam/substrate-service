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
import { parseZones, canRead, canReadZone, zoneFor, SERVICE_ZONE_IDS } from './acl.js';
import { readContentId } from './content-id.js';
import { readTier, normalizeInclude, isQuarantineRejected } from './tier.js';

const SEARCH_EXTS = new Set(['.md', '.csv', '.txt']);
const MAX_RESULTS = 50;
const MAX_SNIPPET = 200;
const MAX_RAW = 500;
// 隔离-rejected 件（tier: rejected，住 inbox 未注册区）在索引里的 zone 哨兵值——registered zone id
// 永不叫 inbox（inbox 是保留的隔离目录，非内容区），故不会撞车。仅供 SQL 预过滤圈定与 JS 收口。
const INBOX_SENTINEL = 'inbox';

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
  const inRegisteredZone = (zones, rel) => {
    const zone = zoneFor(zones, rel);
    return !!zone && !SERVICE_ZONE_IDS.has(zone.id);
  };

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
  // 可索引性也在此判定（返回 [] = 不入索引）：
  //   - 注册 zone 的文件 → 入，zone=该 zone id，tier 从 frontmatter 读（缺省 canonical）。
  //   - inbox/ 下【且】status:rejected + tier:rejected 双条件的隔离件 → 入，zone=哨兵 inbox（缺陷1/2a 的窄特例；
  //     pending/held 无此标记、手写 status:pending + tier:rejected 残留亦不满足 → 不入）。
  //   - 其余未注册路径（governance/skills/keeper-feedback/inbox 的 pending·held）→ 返回 []，永不入索引。
  function rowsForFile(rel, zones) {
    const text = readFileSync(path.join(instanceDir, rel), 'utf8');
    const isMd = rel.endsWith('.md');
    // _incoming 是 staging 对象，不因 SKILL.md 没写 tier 就冒充 canonical；路径状态优先于自报 frontmatter。
    const tier = rel.startsWith('skills/_incoming/') ? 'staging' : (isMd ? readTier(text) : 'canonical');
    const regZone = zoneFor(zones, rel);
    let zone;
    // inbox 即使在真机 zones.md 注册，也仍是隔离区：pending/held 永不入索引；仅 rejected 窄特例可查。
    if (rel.startsWith('inbox/') && isQuarantineRejected(text)) zone = INBOX_SENTINEL;
    else if (regZone && !SERVICE_ZONE_IDS.has(regZone.id)) zone = regZone.id;
    else return []; // 未注册且非 inbox-rejected → 隔离/系统区永不入索引
    const contentId = isMd ? readContentId(text) : null;
    const rows = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const body = preprocess(raw);
      if (!body) continue;
      rows.push([rel, contentId, zone, tier, i + 1, raw.slice(0, MAX_RAW), body]);
    }
    return rows;
  }

  function createSchema(d) {
    d.exec(`DROP TABLE IF EXISTS docs;`);
    d.exec(`CREATE VIRTUAL TABLE docs USING fts5(
      path UNINDEXED, content_id UNINDEXED, zone UNINDEXED, tier UNINDEXED, lineno UNINDEXED, raw UNINDEXED, body,
      tokenize='unicode61'
    );`);
  }

  const INSERT = `INSERT INTO docs(path, content_id, zone, tier, lineno, raw, body) VALUES (?,?,?,?,?,?,?)`;

  // 全量重建：幂等（DROP+CREATE 后从文件全灌）。fixture 规模秒级。只灌注册 zone 的文件（缺陷1）。
  function rebuild() {
    const d = connect();
    const zones = parseZones(instanceDir);
    createSchema(d);
    const ins = d.prepare(INSERT);
    d.exec('BEGIN');
    try {
      for (const rel of walkFiles()) {
        // 免读优化：未注册且不在 inbox/ → 直接跳过（governance/skills/keeper-feedback）。
        // 其余（注册 zone + inbox 件）交给 rowsForFile 按 tier 最终裁定可索引性（inbox 只收 rejected）。
        if (!inRegisteredZone(zones, rel) && !rel.startsWith('inbox/')) continue;
        for (const r of rowsForFile(rel, zones)) ins.run(...r);
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    generation++;
    return { ok: true };
  }

  // 增量：单页更新（keeper 单写口每次归档后 / 直接编辑后调）。无索引先全建。
  // 可索引性完全交给 rowsForFile（未注册且非 inbox-rejected → 返回 []，即只 DELETE 不再插入）——
  // 隔离件（inbox pending/held）即便被直接调用也不会漏进索引（缺陷1）。
  function updatePage(rel) {
    if (!SEARCH_EXTS.has(path.extname(rel))) return;
    if (!hasIndex()) return void rebuild();
    const d = connect();
    const zones = parseZones(instanceDir);
    d.exec('BEGIN');
    try {
      d.prepare('DELETE FROM docs WHERE path = ?').run(rel);
      if (existsSync(path.join(instanceDir, rel))) {
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

  // 查询：query（+可选 zone / trust / include）。过与现有 search 相同的 canRead ACL + tier-aware 分层过滤。
  // include：附加返回的分层（'candidate' / 'rejected'，数组或逗号串），默认只返 canonical（spec §6.3）。
  // 返回 path/content_id/zone/tier/snippet/score(bm25)。
  function query({ query: q, zone, trust = 'low', include, limit = MAX_RESULTS } = {}) {
    if (!q?.trim()) return { results: [] };
    ensureBuilt();
    const d = connect();
    const zones = parseZones(instanceDir);
    const zoneDef = zone ? zones.find((z) => z.id === zone) : null;
    if (zone && !zoneDef) {
      throw new Error(`没有叫 ${zone} 的分区，可用：${zones.map((z) => z.id).join('、')}`);
    }
    // 分层过滤（§6.3）：canonical 恒含；candidate/rejected 需 include 显式开启。
    // staging Skill 只在高信任显式 include 时可查；低信任即便请求该 tier 也不把它送进 SQL。
    const extraTiers = normalizeInclude(include).filter((t) => t !== 'staging' || trust === 'high');
    const tiers = ['canonical', ...extraTiers];

    // 缺陷8：把「按 trust 可读的 zone 集合」预过滤进 SQL（zone IN (...)），令 ACL 在 LIMIT 之前生效——
    // 否则敏感命中多时，over 行全被敏感占满、JS 事后过滤把可读结果挤掉，低信任假落空。
    let allowedZones = zones.filter((z) => canReadZone(z, trust)).map((z) => z.id);
    if (zoneDef) allowedZones = allowedZones.filter((id) => id === zoneDef.id);
    // 隔离-rejected 特例：只有 include 含 rejected、高信任、且未限定其它 zone 时，才放行 inbox 哨兵区——
    // 与 tools.js「未注册 zone 收紧为仅 high 可读」两面一致；低信任/默认档一律看不到隔离件。
    if (extraTiers.includes('rejected') && trust === 'high' && !zoneDef) allowedZones.push(INBOX_SENTINEL);
    if (allowedZones.length === 0) return { results: [] };
    const zoneIn = `zone IN (${allowedZones.map(() => '?').join(',')})`;
    const tierIn = `tier IN (${tiers.map(() => '?').join(',')})`;

    const toks = cjkTokens(q);
    // bigram 索引里没有单字 CJK token → 从 MATCH 里剔除；若全是单字 CJK，整体降级子串扫描。
    const usable = toks.filter((t) => !(t.length === 1 && CJK_RE.test(t)));
    const over = Math.max(limit * 4, limit); // 多取些，留给去重/截断（ACL/tier 已在 SQL 里生效）
    let rows;
    if (usable.length === 0) {
      const singles = toks.filter(Boolean);
      if (!singles.length) return { results: [] };
      const where = singles.map(() => 'raw LIKE ?').join(' AND ');
      rows = d.prepare(`SELECT path, content_id, zone, tier, lineno, raw, 0 AS score FROM docs WHERE ${zoneIn} AND ${tierIn} AND ${where} LIMIT ?`)
        .all(...allowedZones, ...tiers, ...singles.map((s) => `%${s}%`), over);
    } else {
      const match = usable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '); // 引号护体 + 空格=AND
      try {
        rows = d.prepare(
          `SELECT path, content_id, zone, tier, lineno, raw, bm25(docs) AS score FROM docs WHERE docs MATCH ? AND ${zoneIn} AND ${tierIn} ORDER BY score LIMIT ?`
        ).all(match, ...allowedZones, ...tiers, over);
      } catch { rows = []; } // 畸形 MATCH 不崩，返回空
    }
    const results = [];
    for (const r of rows) {
      if (r.zone === INBOX_SENTINEL) {
        if (trust !== 'high') continue; // 纵深防御：隔离件仅高信任可见（SQL 已圈定，这里双保险）
      } else {
        if (zoneDef && !r.path.startsWith(zoneDef.path)) continue;
        if (!canRead(zones, r.path, trust)) continue; // 纵深防御：SQL 已圈定，这里双保险
      }
      results.push({
        path: r.path,
        content_id: r.content_id ?? null,
        zone: r.zone === INBOX_SENTINEL ? null : (r.zone ?? null),
        tier: r.tier ?? 'canonical',
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
