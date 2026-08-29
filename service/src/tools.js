// 五个读工具的实现（M1）。全部只读实例工作副本；trust 缺省按最低处理。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseZones, canRead, canReadZone, zoneFor, SERVICE_ZONE_IDS } from './acl.js';
import { readTier, normalizeInclude, isQuarantineRejected } from './tier.js';

// SEC-6：直读结果面路径单行化——删控制字符（\r\n\t 等 Cc）+ Unicode 格式字符（零宽/BOM 等 Cf）+
// 行/段分隔符（U+2028/U+2029，Zl/Zp）。search 返回的 path、recall 的 citations path 都是裸文件名、未过任何
// 中和；攻击者可 push 一个文件名内嵌换行/Markdown/控制字符的伪造件（经 git pull 进库），裸拼进下游 agent
// 的提示面即成注入（keeper.js 的 displaySafePath 为治理/日志面建的中和，直读结果面没享受到）。
// 只【删】不实体化——保持路径仍可回传 read_page；合法路径本不含这些字符（零副作用），带这些字符的文件名
// 是病态伪造件，删后不可用即预期。刻意不复用 displaySafePath（它把 [ / # / 反引号实体化，会让路径无法回传）。
const oneLinePath = (p) => String(p ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, '');

const SEARCH_EXTS = new Set(['.md', '.csv', '.txt']);
const MAX_RESULTS = 50;
const MAX_SNIPPET = 200;
const MAX_FIELD = 400;
// M4.7 collections_search v2：
// - MAX_LIMIT：limit 硬上限。为什么要有——防 agent 一把要求超大页绕过分页把整表拉进单次响应（真机事故根因）。
//   为什么是 200 而非报错——超上限「夹到 200」比硬报错宽容：agent 拿到 200 行 + truncated + next_offset 能自己翻页
//   补齐，不必因一个参数越界而整次失败。200 行足够密、又远低于会撑爆宿主的量级。
// - MAX_ROWS_BYTES：rows 序列化后的字节预算（约 40KB）。为什么这个量级——对齐 Hermes 这类工具宿主「几十 KB」档，
//   且给外层 JSON 包裹 + 主频道 nudge 尾注留余量。只预算 rows（列名/total 等元字段极小，不入账）。超预算从尾部裁行。
const MAX_LIMIT = 200;
const MAX_ROWS_BYTES = 40 * 1024;

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
      const matchedZone = zoneFor(zs, rel);
      const registered = !!matchedZone && !SERVICE_ZONE_IDS.has(matchedZone.id);
      if (registered) {
        if (!canRead(zs, rel, trust)) continue;
      } else if (!(allowInboxRejected && rel.startsWith('inbox/'))) {
        continue; // 未注册路径：除 inbox 隔离-rejected 窄例外，一律不扫
      }
      const text = readFileSync(path.join(instanceDir, rel), 'utf8');
      // inbox 即使在生产 zones.md 注册，仍只开放 rejected 窄特例；pending/held 任意 trust/include 均不可查。
      if (!registered && !isQuarantineRejected(text)) continue;
      // tier 从 frontmatter 读（无 → canonical）；不在请求档内的页整页跳过（candidate/rejected 默认不现）。
      const stagedSkill = rel.startsWith('skills/_incoming/');
      if (stagedSkill && trust !== 'high') continue;
      const tier = stagedSkill ? 'staging' : (rel.endsWith('.md') ? readTier(text) : 'canonical');
      if (!wantTiers.has(tier)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          // SEC-6：path 单行化后再入结果——裸 rel 可能带换行/控制字符（伪造文件名注入），下游不得原样拼提示面。
          results.push({ path: oneLinePath(rel), line: i + 1, tier, snippet: lines[i].trim().slice(0, MAX_SNIPPET) });
          if (results.length >= MAX_RESULTS) return { results, truncated: true };
        }
      }
    }
    return { results };
  }

  async function readPage({ path: relPath, trust = 'low' }) {
    const { abs, rel } = safeResolve(relPath);
    // SEC-3：read_page 必须命中【注册 zone】且过 canReadZone。
    // 洞在哪：acl.js 的 canRead(null, trust) 对未注册 zone 恒返回 true（为 search/index「未注册即不扫」的收紧
    // 而设的默认放行）。read_page 这条直读通路旧代码直接调 canRead，误用了这个默认放行——低信任/免认证客户端
    // 只要知道路径即可直读 inbox/（别的客户端在途待判正文，含 memory 事实）、keeper-feedback/_cases.md（主人裁定
    // 史）、governance/、skills/。search/index 侧都精心收紧成「只扫注册 zone」，唯独 read_page 漏了。
    // 修法：要求 zoneFor 非 null（命中注册 zone）+ 过 canReadZone；未注册路径（inbox/keeper-feedback/governance/
    // skills 及任何非 zone 根文件）一律拒——那正是漏洞面。zone 判定在 exists 之前，顺带不给未注册路径存在性预言。
    const zs = zones();
    const zone = zoneFor(zs, rel);
    if (!zone) {
      throw new Error(`拒绝：${rel} 不在可读知识分区内（inbox/治理/骨架区不经 read_page 读取；如需管理读取请用高信任专用通路）`);
    }
    if (!canReadZone(zone, trust)) {
      const why = SERVICE_ZONE_IDS.has(zone.id) ? '属于服务/治理区，不经 read_page 读取' : '属于 sensitive 敏感分区，当前客户端信任级不足';
      throw new Error(`拒绝：${rel} ${why}`);
    }
    if (rel.startsWith('skills/_incoming/') && trust !== 'high') {
      throw new Error(`拒绝：${rel} 是尚未晋升的 staging Skill，仅高信任审核通路可读`);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`没有这个文件：${rel}`);
    return { path: rel, content: readFileSync(abs, 'utf8') };
  }

  // digest v2 化：实例 vendored 的 render-context.py 是 v1 渲染器，输出携带 v1 时代的
  // 技能路由表 / v1 房规 / Packet 操作行——它们指挥 agent 调已退役的本地 skill、直接改文件、
  // 跑 wire-context 刷新，与 DIGEST_RULES「读写一律走 MCP 工具」在同一份提示里直接矛盾。
  // 实例数据与 v1 脚本都不动，在渲染出口统一剥锈：
  // ① 整段剥除「## 何时用哪个 skill…」与「## 房规（substrate 常驻接入）」（v2 房规由 DIGEST_RULES/instructions 下发）；
  // ② 剥除 Packet 操作行（维护 skill / 写前查 / 写后更新——v2 写入经 inbox 治理，不教 agent 直改文件）；
  // ③ substrate-memory 技能引用改写成 read_page 口径。
  function stripV1Sections(text) {
    const out = [];
    let skipping = false;
    for (const line of text.split('\n')) {
      if (/^## /.test(line)) {
        skipping = /^## (何时用哪个 skill|房规（substrate 常驻接入）)/.test(line);
      }
      if (skipping) continue;
      if (/^>\s*-\s*(维护 skill|写前查|写后更新)[:：]/.test(line)) continue;
      out.push(line);
    }
    // substrate-memory 已是不存在的 v1 技能——digest 里任何提法（含库数据正文里的变体措辞）
    // 一律译成 v2 的 read_page 工具口径，消费方才有可执行的指引。
    return `${out.join('\n')
      .replace(/`?substrate-memory`?/g, 'read_page')
      .replace(/\n{3,}/g, '\n\n')
      .trim()}\n`;
  }

  async function getContext({ trust = 'low' }) {
    // 常驻上下文内嵌 about-owner 核心（sensitive），与 memory 区同级把关
    if (trust !== 'high') throw new Error('拒绝：常驻上下文含 sensitive 敏感记忆，当前客户端信任级不足');
    const script = path.join(instanceDir, 'skills', 'substrate-runtime-context', 'render-context.py');
    const content = await new Promise((resolve, reject) => {
      execFile('python3', [script], { cwd: instanceDir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(`render-context 失败：${stderr || err.message}`)) : resolve(stdout)));
    });
    return { content: stripV1Sections(content) };
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

  // M4.7 collections_search v2：向后兼容 {name,query}，新增 where（按列过滤）/columns（列投影）/limit+offset（翻页）
  // + 字节预算裁行 + truncated 契约（agent 自救）。约束：列名一律走 header 白名单比对（防原型污染、防回显行数据），
  // 路径穿越防护（name 的 / 与 ..）不削弱。
  async function collectionsSearch({ name, query, where, columns, limit, offset }) {
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

    // 列名白名单校验：where 的键、columns 的每一项都必须是真实列名。只拿 header.includes 比对，绝不拿用户输入
    // 当对象键去索引——__proto__/constructor 等自然落进「未知列」被拒。错误信息可列可用列名，但不回显任何行数据。
    const whereObj = (where && typeof where === 'object' && !Array.isArray(where)) ? where : null;
    const unknownIn = (names) => names.filter((c) => !header.includes(c));
    if (whereObj) {
      const bad = unknownIn(Object.keys(whereObj));
      if (bad.length) throw new Error(`收藏「${name}」没有这些列：${bad.join('、')}，可用列：${header.join('、')}`);
    }
    if (columns) {
      const bad = unknownIn(columns);
      if (bad.length) throw new Error(`收藏「${name}」没有这些列：${bad.join('、')}，可用列：${header.join('、')}`);
    }

    // 分页参数：limit 正整数、超上限夹到 MAX_LIMIT（宽容，配合 truncated 仍可翻页）；offset 非负整数、越界返空。
    const lim = Math.min(normPageArg(limit, MAX_RESULTS, 1, 'limit'), MAX_LIMIT);
    const off = normPageArg(offset, 0, 0, 'offset');

    // 过滤：query（全字段模糊，旧语义不变）与 where（按列模糊）AND；两者都大小写不敏感 contains。
    const needle = (query ?? '').trim().toLowerCase();
    const whereChecks = whereObj
      ? Object.entries(whereObj).map(([col, sub]) => [header.indexOf(col), String(sub).toLowerCase()])
      : [];
    const matched = dataRows.filter((r) =>
      (!needle || r.some((v) => v.toLowerCase().includes(needle))) &&
      whereChecks.every(([i, sub]) => (r[i] ?? '').toLowerCase().includes(sub)));

    // 列投影（未给=全列）+ 字段级 MAX_FIELD 截断（字段级截断不计入 truncated 契约）。
    const project = columns ?? header;
    const idxOf = project.map((h) => header.indexOf(h));
    const toObj = (r) => Object.fromEntries(project.map((h, k) => [h, (r[idxOf[k]] ?? '').slice(0, MAX_FIELD)]));

    const page = matched.slice(off, off + lim).map(toObj);
    const limitCut = off + lim < matched.length; // 本页之后还有匹配行 = 被 limit 裁

    // 字节预算：从尾部丢行直到 rows 序列化 ≤ MAX_ROWS_BYTES（至少保 1 行，避免整表空返）。
    const { rows, byteCut } = trimToByteBudget(page, MAX_ROWS_BYTES);

    const out = { name, columns: project, rows, total: dataRows.length };
    // truncated 契约（关键，agent 要能自救）：凡被 limit 或字节预算裁，带四件套；未截断时省略（与 search 风格一致）。
    if (limitCut || byteCut) {
      out.truncated = true;
      out.returned = rows.length;
      out.next_offset = off + rows.length; // 下一页起点 = 本次 offset + 实返行数（字节裁少于 limit 时也对）
      out.hint = '结果被截断：用 where 按列过滤、columns 只取需要的列来收窄，或用 limit+offset 翻页（next_offset 是下一页起点）。';
    }
    return out;
  }

  return { search, readPage, getContext, todoList, collectionsSearch };
}

// 分页入参校验：null=默认；否则必须是 ≥ min 的整数，非法即报友好错误（direct 调用防御——MCP 侧 zod 亦先挡一道）。
function normPageArg(v, dflt, min, label) {
  if (v == null) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new Error(`${label} 必须是 ≥ ${min} 的整数`);
  }
  return v;
}

// 字节预算裁行：增量累加每行序列化字节（行 JSON + 分隔符，估值偏大更保守），超预算即从尾部截断。
// 至少保 1 行：单行经 MAX_FIELD 限幅后仅几 KB，不会单行超 40KB 预算，保 1 行只是防御性兜底。
function trimToByteBudget(rows, budget) {
  const kept = [];
  let used = 2; // "[]"
  for (const row of rows) {
    const b = Buffer.byteLength(JSON.stringify(row)) + 1; // +1 ≈ 逗号
    if (kept.length && used + b > budget) return { rows: kept, byteCut: true };
    kept.push(row); used += b;
  }
  return { rows: kept, byteCut: false };
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
