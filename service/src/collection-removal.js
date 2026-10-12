// 收藏行的有界删除：只按显式 id 精确删 collections/<name>/data.csv 的记录，并同步同级 Markdown 的总数声明。
// 不做子串/过滤表达式/glob/模型解析；缺失 id 是幂等 no-op；源 CSV 有重复 id 一律拒绝（fail closed）。
// 保留每条存活记录、表头、BOM、行尾的原始字节——只切掉被删记录自己的字节段，从不重新序列化无关行。
// 写者事务、doctor、回滚、commit、索引刷新与 native 证明均由调用方负责；本模块不是独立 CLI。
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';

export const MAX_REMOVAL_IDS = 200;
export const MAX_REMOVAL_ID_LENGTH = 200;
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
// 与 executor.js upsertRow / doctor 同一条总数声明正则；只改同级页，子目录分片有自己的子集计数。
const TOTAL_CLAIM_RE = /(\*\*\s*)\d+(\s*\*\*\s*(?:条|rows|entries))/g;
// Python str.strip() 的空白集合（与 JS trim 不同：含 \x1c-\x1f、\x85，不含 \ufeff），保证计数与 doctor 一致。
const PY_NON_SPACE_RE = /[^\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function removalError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function preview(value) {
  const s = JSON.stringify(String(value));
  return s.length > 80 ? `${s.slice(0, 77)}…"` : s;
}

function checkedCollection(collection) {
  if (typeof collection !== 'string' || !COLLECTION_RE.test(collection)) {
    throw removalError('COLLECTION_REMOVAL_INVALID', `收藏名不合法：${preview(collection)}`);
  }
  return collection;
}

function checkedIds(ids) {
  if (!Array.isArray(ids)) throw removalError('COLLECTION_REMOVAL_INVALID', 'ids 必须是数组');
  if (ids.length < 1 || ids.length > MAX_REMOVAL_IDS) {
    throw removalError('COLLECTION_REMOVAL_INVALID', `ids 数量须为 1..${MAX_REMOVAL_IDS}，实际 ${ids.length}`);
  }
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || id !== id.trim()) {
      throw removalError('COLLECTION_REMOVAL_INVALID', `id 须为非空且无首尾空白的字符串：${preview(id)}`);
    }
    if (id.length > MAX_REMOVAL_ID_LENGTH) {
      throw removalError('COLLECTION_REMOVAL_INVALID', `id 超过 ${MAX_REMOVAL_ID_LENGTH} 字符：${preview(id)}`);
    }
    if (/\p{Cc}/u.test(id)) throw removalError('COLLECTION_REMOVAL_INVALID', `id 含控制字符：${preview(id)}`);
    if (seen.has(id)) throw removalError('COLLECTION_REMOVAL_INVALID', `ids 重复：${preview(id)}`);
    seen.add(id);
  }
  return [...ids];
}

// 实例根本身与其下每一级（collections/、<name>/）都必须是真实目录，不跟随符号链接。
function assertRealDir(abs, label) {
  let st;
  try { st = lstatSync(abs); } catch (error) {
    if (error.code === 'ENOENT') throw removalError('COLLECTION_REMOVAL_NOT_FOUND', `${label} 不存在`);
    throw error;
  }
  if (st.isSymbolicLink()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${label} 是符号链接`);
  if (!st.isDirectory()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${label} 不是目录`);
}

// O_NOFOLLOW + fstat：读到的一定是本次 lstat 认可的那个普通文件，FIFO/设备/符号链接一律拒绝。
function readRegularText(abs, rel) {
  // 先 lstat（O_NOFOLLOW 缺失的平台也不跟随），再以 O_NOFOLLOW 打开兜住检查与打开之间的替换。
  let pre;
  try { pre = lstatSync(abs); } catch (error) {
    if (error.code === 'ENOENT') throw removalError('COLLECTION_REMOVAL_NOT_FOUND', `${rel} 不存在`);
    throw error;
  }
  if (pre.isSymbolicLink()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 是符号链接`);
  if (!pre.isFile()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 不是普通文件`);
  let fd;
  try { fd = openSync(abs, READ_FLAGS); } catch (error) {
    if (error.code === 'ENOENT') throw removalError('COLLECTION_REMOVAL_NOT_FOUND', `${rel} 不存在`);
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 是符号链接`);
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== pre.dev || st.ino !== pre.ino) {
      throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 不是普通文件或在检查后被替换`);
    }
    let text;
    try { text = utf8.decode(readFileSync(fd)); } catch {
      throw removalError('COLLECTION_REMOVAL_ENCODING', `${rel} 不是合法 UTF-8`);
    }
    return { text, dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

function writeRegularText(abs, rel, text, expected) {
  let fd;
  try { fd = openSync(abs, WRITE_FLAGS); } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK' || error.code === 'ENXIO') {
      throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 在预读后被替换，拒绝写入`);
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) {
      throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `${rel} 在预读后被替换，拒绝写入`);
    }
    const buf = Buffer.from(text, 'utf8');
    ftruncateSync(fd, 0);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, off);
  } finally {
    closeSync(fd);
  }
}

// RFC 4180 解析，保留每条记录在原文中的 [start, end)（含其自身行尾）。比 Python csv（非 strict）更严：
// 引号只能出现在字段开头、闭合引号后只能接逗号/行尾、不允许裸 CR 与 NUL，否则一律拒绝。
function parseCsvRecords(text, rel) {
  const bad = (msg, at) => {
    const line = text.slice(0, at).split('\n').length;
    return removalError('COLLECTION_REMOVAL_CSV_INVALID', `${rel} 第 ${line} 行 CSV 不合法：${msg}`);
  };
  const nul = text.indexOf('\0');
  if (nul >= 0) throw bad('含 NUL 字符', nul);
  const bomLength = text.startsWith('\ufeff') ? 1 : 0;
  const records = [];
  const n = text.length;
  let i = bomLength;
  while (i < n) {
    const start = i;
    const cells = [];
    let cell = '';
    let fieldStart = true;
    let quoted = false;
    let closedQuote = false;
    let quoteAt = -1;
    let contentEnd = n;
    while (i < n) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') { cell += ch; i++; continue; }
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false;
        closedQuote = true;
        i++;
        continue;
      }
      if (ch === ',') {
        cells.push(cell);
        cell = '';
        fieldStart = true;
        closedQuote = false;
        i++;
        continue;
      }
      if (ch === '\n') { contentEnd = i; i++; break; }
      if (ch === '\r') {
        if (text[i + 1] !== '\n') throw bad('出现裸 CR（只接受 LF 或 CRLF 行尾）', i);
        contentEnd = i;
        i += 2;
        break;
      }
      if (closedQuote) throw bad('引号字段闭合后还有多余字符', i);
      if (ch === '"') {
        if (!fieldStart) throw bad('未加引号的字段中出现引号', i);
        quoted = true;
        quoteAt = i;
        fieldStart = false;
        i++;
        continue;
      }
      cell += ch;
      fieldStart = false;
      i++;
    }
    if (quoted) throw bad('引号未闭合', quoteAt);
    cells.push(cell);
    records.push({ start, end: i, cells, blank: contentEnd === start });
  }
  return records;
}

function nonEmptyRow(cells) {
  return cells.some((cell) => PY_NON_SPACE_RE.test(cell));
}

function analyzeCsv(text, rel) {
  const records = parseCsvRecords(text, rel);
  if (!records.length || records[0].blank) {
    throw removalError('COLLECTION_REMOVAL_CSV_INVALID', `${rel} 首行必须是表头`);
  }
  const header = records[0].cells;
  const idCols = header.flatMap((name, idx) => (name === 'id' ? [idx] : []));
  if (idCols.length !== 1) {
    throw removalError('COLLECTION_REMOVAL_CSV_INVALID', `${rel} 表头须恰有一个 id 列，实际 ${idCols.length} 个`);
  }
  const idCol = idCols[0];
  const byId = new Map();
  for (const record of records.slice(1)) {
    // 空行既不计数也不参与校验，原样保留（Python csv.reader 读成 []，doctor 同样跳过）。
    if (record.blank) continue;
    if (record.cells.length !== header.length) {
      const line = text.slice(0, record.start).split('\n').length;
      throw removalError('COLLECTION_REMOVAL_CSV_INVALID',
        `${rel} 第 ${line} 行列数 ${record.cells.length} 与表头 ${header.length} 不一致`);
    }
    // 计数口径 = doctor：任一单元格 strip 后非空才算一行；全空白行不计数、不可被 id 命中。
    if (!nonEmptyRow(record.cells)) continue;
    const id = record.cells[idCol];
    if (byId.has(id)) {
      throw removalError('COLLECTION_REMOVAL_DUPLICATE_ID', `${rel} 存在重复 id：${preview(id)}，拒绝删除`);
    }
    byId.set(id, record);
  }
  return { records, byId, count: byId.size };
}

function idList(ids) {
  const shown = ids.slice(0, 10).join('、');
  return ids.length > 10 ? `${shown} 等 ${ids.length} 个` : shown;
}

// 读、校验、算出全部目标内容，但不写任何文件。inspect 与 apply 共用，apply 每次都重新跑一遍。
function planRemoval(instanceDir, collection, ids) {
  const name = checkedCollection(collection);
  const wanted = checkedIds(ids);
  if (typeof instanceDir !== 'string' || !instanceDir) {
    throw removalError('COLLECTION_REMOVAL_INVALID', 'instanceDir 必须是非空路径');
  }
  const root = path.resolve(instanceDir);
  assertRealDir(root, '实例目录');
  assertRealDir(path.join(root, 'collections'), 'collections/');
  const dirRel = `collections/${name}`;
  const dirAbs = path.join(root, 'collections', name);
  assertRealDir(dirAbs, `收藏 ${dirRel}/`);
  const csvRel = `${dirRel}/data.csv`;
  const csvAbs = path.join(root, csvRel);
  const csvFile = readRegularText(csvAbs, csvRel);
  const { records, byId, count: countBefore } = analyzeCsv(csvFile.text, csvRel);

  const removedIds = wanted.filter((id) => byId.has(id));
  const missingIds = wanted.filter((id) => !byId.has(id));
  const count = countBefore - removedIds.length;
  const removing = new Set(removedIds.map((id) => byId.get(id)));
  let csvAfter = csvFile.text;
  if (removing.size) {
    // 只切掉被删记录自身的字节段（含其行尾）；其余字节按原样拼回。
    const parts = [csvFile.text.slice(0, records[0].start)];
    for (const record of records) if (!removing.has(record)) parts.push(csvFile.text.slice(record.start, record.end));
    csvAfter = parts.join('');
  }

  // 同级 .md 一律预读并校验：符号链接或非普通文件直接拒绝，避免写到一半才发现。子目录不碰。
  const derived = [];
  const entries = readdirSync(dirAbs, { withFileTypes: true })
    .filter((ent) => ent.name.endsWith('.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const rel = `${dirRel}/${ent.name}`;
    if (ent.isSymbolicLink()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `同级页 ${rel} 是符号链接，拒绝删除`);
    if (!ent.isFile()) throw removalError('COLLECTION_REMOVAL_PATH_UNSAFE', `同级页 ${rel} 不是普通文件，拒绝删除`);
    const abs = path.join(dirAbs, ent.name);
    const file = readRegularText(abs, rel);
    const after = removing.size ? file.text.replace(TOTAL_CLAIM_RE, (_, a, b) => `${a}${count}${b}`) : file.text;
    if (after !== file.text) derived.push({ rel, abs, file, after });
  }

  return {
    collection: name,
    csvRel,
    requestedIds: wanted,
    removedIds,
    missingIds,
    countBefore,
    count,
    derivedPaths: derived.map((d) => d.rel),
    writes: removing.size
      ? [{ rel: csvRel, abs: csvAbs, file: csvFile, after: csvAfter }, ...derived]
      : [],
  };
}

function publicPlan({ writes, ...plan }) {
  return plan;
}

// 只读预检：非法输入/路径/CSV 直接抛错；返回将删的 id、缺失的 id、删除后的总数、会被同步的同级页。
export function inspectCollectionRemoval(instanceDir, collection, ids) {
  return publicPlan(planRemoval(instanceDir, collection, ids));
}

// 按当前文件状态重新预检后落盘。纯缺失（含重试）不写任何文件，也不改同级页计数。
export function applyCollectionRemoval(instanceDir, collection, ids) {
  const plan = planRemoval(instanceDir, collection, ids);
  const missingNote = plan.missingIds.length ? `；${plan.missingIds.length} 个 id 不存在已跳过（${idList(plan.missingIds)}）` : '';
  if (!plan.writes.length) {
    return {
      ...publicPlan(plan),
      changedPaths: [],
      detail: `${plan.collection} 无匹配行，未改动${missingNote}`,
    };
  }
  for (const w of plan.writes) writeRegularText(w.abs, w.rel, w.after, w.file);
  return {
    ...publicPlan(plan),
    changedPaths: plan.writes.map((w) => w.rel),
    detail: `${plan.collection} 删除 ${plan.removedIds.length} 行（${idList(plan.removedIds)}），剩 ${plan.count} 条${missingNote}`,
  };
}
