import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inspectCollectionRemoval, applyCollectionRemoval, MAX_REMOVAL_IDS, MAX_REMOVAL_ID_LENGTH,
} from '../src/collection-removal.js';

// 虚构数据：一个茶叶收藏，覆盖 BOM、CRLF/LF 混排、多行引号字段、转义引号、空行、全空白行、末行无换行。
const R = {
  header: '\ufeffid,title,notes,tags\r\n',
  a: 'tea-001,Moonlit Oolong,"line one\r\nline two",green\r\n',
  b: 'tea-002,"Quote ""Smoke"" Lapsang","multi\nline, with comma",black\n',
  blank: '\r\n',
  c: 'tea-003,Plain Sencha,,\r\n',
  ws: ' , ,\t, \n',
  d: '"tea-004","Jasmine, Pearl","ends with quote """,white',
};
const BASE_CSV = Object.values(R).join('');
const README = [
  '# Tea shelf',
  '',
  '共 **4** 条记录。',
  'Also **4 ** rows and ** 4** entries tracked.',
  'Not a claim: **4** items.',
  '',
].join('\n');

function makeInstance(csv = BASE_CSV, { collection = 'tea-shelf', files = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'substrate-collection-removal-'));
  const dir = path.join(root, 'collections', collection);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'data.csv'), csv);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return { root, dir, collection, csvAbs: path.join(dir, 'data.csv') };
}

function snapshot(root) {
  const out = {};
  for (const rel of readdirSync(root, { recursive: true })) {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out[rel] = 'symlink';
    else if (st.isFile()) out[rel] = readFileSync(abs).toString('base64');
  }
  return out;
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

let hasPython = true;
try { execFileSync('python3', ['-c', 'pass']); } catch { hasPython = false; }

// 与 doctor / collections.py count 同一口径：utf-8-sig + csv.reader + 任一单元格 strip 后非空。
function pythonCount(file) {
  const script = [
    'import csv, sys',
    'with open(sys.argv[1], newline="", encoding="utf-8-sig") as fh:',
    '    rows = [r for r in csv.reader(fh) if any(c.strip() for c in r)]',
    'print(max(len(rows) - 1, 0))',
  ].join('\n');
  return Number(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }).trim());
}

test('inspect 只读：精确 id、缺失 id、删除后计数与将同步的同级页', () => {
  const { root, collection } = makeInstance(BASE_CSV, { files: { 'README.md': README, 'plain.md': '# no claims\n' } });
  const before = snapshot(root);
  const plan = inspectCollectionRemoval(root, collection, ['tea-004', 'ghost', 'tea-002']);
  assert.equal(plan.csvRel, 'collections/tea-shelf/data.csv');
  assert.deepEqual(plan.removedIds, ['tea-004', 'tea-002']);
  assert.deepEqual(plan.missingIds, ['ghost']);
  assert.equal(plan.countBefore, 4);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.derivedPaths, ['collections/tea-shelf/README.md']);
  assert.deepEqual(snapshot(root), before);
});

test('只认精确 id：子串、大小写变体、glob、正则、标题都不命中', () => {
  const { root, collection } = makeInstance(BASE_CSV, { files: { 'README.md': README } });
  const before = snapshot(root);
  const ids = ['tea-00', 'TEA-001', 'tea-*', '.*', 'tea-00?', 'Moonlit Oolong', 'id'];
  const plan = inspectCollectionRemoval(root, collection, ids);
  assert.deepEqual(plan.removedIds, []);
  assert.deepEqual(plan.missingIds, ids);
  assert.equal(plan.count, 4);
  const result = applyCollectionRemoval(root, collection, ids);
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(snapshot(root), before);
});

test('apply 只切掉被删记录：多行引号/转义引号/CRLF/BOM/空行与其余字节原样保留，并与 Python 计数一致', (t) => {
  const { root, collection, csvAbs } = makeInstance(BASE_CSV, { files: { 'README.md': README } });
  const result = applyCollectionRemoval(root, collection, ['tea-002', 'tea-004']);
  const expected = R.header + R.a + R.blank + R.c + R.ws;
  assert.ok(readFileSync(csvAbs).equals(Buffer.from(expected, 'utf8')));
  assert.deepEqual(result.removedIds, ['tea-002', 'tea-004']);
  assert.equal(result.count, 2);
  assert.match(result.detail, /tea-shelf 删除 2 行/);
  if (hasPython) assert.equal(pythonCount(csvAbs), result.count);
  else t.diagnostic('python3 不可用，跳过 Python 计数对照');
});

test('删除多行引号字段所在记录，相邻记录字节不变', () => {
  const { root, collection, csvAbs } = makeInstance();
  applyCollectionRemoval(root, collection, ['tea-001']);
  assert.equal(readFileSync(csvAbs, 'utf8'), R.header + R.b + R.blank + R.c + R.ws + R.d);
});

test('含逗号与引号的 id 按解析后的单元格精确匹配', () => {
  const csv = 'id,label\n"odd,""one""",x\nodd,y\n';
  const { root, collection, csvAbs } = makeInstance(csv);
  const result = applyCollectionRemoval(root, collection, ['odd,"one"']);
  assert.deepEqual(result.removedIds, ['odd,"one"']);
  assert.equal(readFileSync(csvAbs, 'utf8'), 'id,label\nodd,y\n');
});

test('删掉末尾无换行的记录：前一条记录连同其行尾原样保留', () => {
  const { root, collection, csvAbs } = makeInstance('id,v\nk1,1\nk2,2');
  applyCollectionRemoval(root, collection, ['k2']);
  assert.equal(readFileSync(csvAbs, 'utf8'), 'id,v\nk1,1\n');
});

test('计数同步：只改同级 .md 的总数声明，子目录分片、非 md 文件、无声明页不动', () => {
  const shard = '# 2026 shard\n本分片 **4** 条。\n';
  const files = {
    'README.md': README,
    'plain.md': '# no claims\n',
    'notes.txt': '共 **4** 条\n',
    'shards/2026.md': shard,
    'shards/deeper/more.md': 'Total **4** rows\n',
  };
  const { root, dir, collection } = makeInstance(BASE_CSV, { files });
  const before = snapshot(root);
  const result = applyCollectionRemoval(root, collection, ['tea-003']);
  assert.deepEqual(result.changedPaths, ['collections/tea-shelf/data.csv', 'collections/tea-shelf/README.md']);
  assert.equal(readFileSync(path.join(dir, 'README.md'), 'utf8'), [
    '# Tea shelf',
    '',
    '共 **3** 条记录。',
    'Also **3 ** rows and ** 3** entries tracked.',
    'Not a claim: **4** items.',
    '',
  ].join('\n'));
  const after = snapshot(root);
  for (const rel of ['plain.md', 'notes.txt', 'shards/2026.md', 'shards/deeper/more.md']) {
    const key = path.join('collections', 'tea-shelf', rel);
    assert.equal(after[key], before[key], `${rel} 不应被改动`);
  }
});

test('删光所有行：只剩表头，计数归零', () => {
  const { root, collection, csvAbs, dir } = makeInstance(BASE_CSV, { files: { 'README.md': README } });
  const result = applyCollectionRemoval(root, collection, ['tea-001', 'tea-002', 'tea-003', 'tea-004']);
  assert.equal(result.count, 0);
  assert.equal(readFileSync(csvAbs, 'utf8'), R.header + R.blank + R.ws);
  assert.match(readFileSync(path.join(dir, 'README.md'), 'utf8'), /共 \*\*0\*\* 条/);
});

test('幂等：重试只剩缺失 id 时零写入，即使同级页计数已陈旧也不碰', () => {
  const { root, dir, collection } = makeInstance(BASE_CSV, { files: { 'README.md': README } });
  const first = applyCollectionRemoval(root, collection, ['tea-001', 'never-existed']);
  assert.equal(first.changedPaths.length, 2);
  assert.deepEqual(first.missingIds, ['never-existed']);
  const settled = snapshot(root);
  const retry = applyCollectionRemoval(root, collection, ['tea-001', 'never-existed']);
  assert.deepEqual(retry.changedPaths, []);
  assert.deepEqual(retry.removedIds, []);
  assert.deepEqual(retry.missingIds, ['tea-001', 'never-existed']);
  assert.match(retry.detail, /未改动/);
  assert.deepEqual(snapshot(root), settled);

  writeFileSync(path.join(dir, 'README.md'), '共 **99** 条\n');
  const stale = snapshot(root);
  assert.deepEqual(applyCollectionRemoval(root, collection, ['tea-001']).changedPaths, []);
  assert.deepEqual(snapshot(root), stale);
});

test('apply 重新预检当前状态，不沿用早先 inspect 的结论', () => {
  const { root, collection, csvAbs } = makeInstance('id,v\nk1,1\nk2,2\n');
  assert.deepEqual(inspectCollectionRemoval(root, collection, ['k1']).removedIds, ['k1']);
  writeFileSync(csvAbs, 'id,v\nk2,2\n');
  const result = applyCollectionRemoval(root, collection, ['k1']);
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(result.missingIds, ['k1']);
});

test('计数口径与 doctor 一致：Python 的空白集合（\\x1c 算空白、\\ufeff 不算）', (t) => {
  if (!hasPython) return t.skip('python3 不可用');
  // JS trim \u53e3\u5f84\u4f1a\u5f97 4\uff08\u628a \x1c/\x85 \u884c\u7b97\u8fdb\u3001\u628a \ufeff \u884c\u6f0f\u6389\uff09\uff1bPython \u53e3\u5f84\u662f 3\u3002
  const csv = 'id,v\nk1,1\n\x1c,\u3000\n\x85,\x1d\n\ufeff,\n,\n\nk2,2\n';
  const { root, collection, csvAbs } = makeInstance(csv);
  const plan = inspectCollectionRemoval(root, collection, ['k1']);
  assert.equal(plan.countBefore, 3);
  assert.equal(plan.countBefore, pythonCount(csvAbs));
  applyCollectionRemoval(root, collection, ['k1']);
  assert.equal(plan.count, pythonCount(csvAbs));
});

test('非法 id 一律拒绝', () => {
  const { root, collection } = makeInstance();
  const cases = [
    'tea-001', undefined, null, {}, [], Array.from({ length: MAX_REMOVAL_IDS + 1 }, (_, i) => `x${i}`),
    ['tea-001', 'tea-001'], [''], ['  '], [' tea-001'], ['tea-001 '], [42], [null],
    ['tea\n001'], ['tea\r001'], ['tea\t001'], ['tea\u0000001'], ['tea\u007f001'], ['tea\u0085001'],
    ['x'.repeat(MAX_REMOVAL_ID_LENGTH + 1)],
  ];
  for (const ids of cases) {
    throwsCode(() => inspectCollectionRemoval(root, collection, ids), 'COLLECTION_REMOVAL_INVALID');
    throwsCode(() => applyCollectionRemoval(root, collection, ids), 'COLLECTION_REMOVAL_INVALID');
  }
});

test('id 边界：200 个、每个 200 字符可接受', () => {
  const { root, collection } = makeInstance();
  const ids = Array.from({ length: MAX_REMOVAL_IDS }, (_, i) => `${i}-`.padEnd(MAX_REMOVAL_ID_LENGTH, 'z'));
  const plan = inspectCollectionRemoval(root, collection, ids);
  assert.equal(plan.missingIds.length, MAX_REMOVAL_IDS);
});

test('非法收藏名一律拒绝', () => {
  const { root } = makeInstance(BASE_CSV, { collection: 'Tea_Shelf-2026' });
  assert.equal(inspectCollectionRemoval(root, 'Tea_Shelf-2026', ['x']).csvRel, 'collections/Tea_Shelf-2026/data.csv');
  for (const name of ['', '../tea-shelf', 'a/b', '_tea', '-tea', '.tea', 'tea shelf', 'tea\n', 'x'.repeat(101), null, 7]) {
    throwsCode(() => inspectCollectionRemoval(root, name, ['x']), 'COLLECTION_REMOVAL_INVALID');
  }
});

test('路径：缺失目录/文件、非目录、非普通文件', () => {
  const { root, dir, collection } = makeInstance();
  throwsCode(() => inspectCollectionRemoval(root, 'no-such', ['x']), 'COLLECTION_REMOVAL_NOT_FOUND');
  throwsCode(() => inspectCollectionRemoval(path.join(root, 'nope'), collection, ['x']), 'COLLECTION_REMOVAL_NOT_FOUND');

  const noCsv = makeInstance();
  const emptyDir = path.join(noCsv.root, 'collections', 'empty');
  mkdirSync(emptyDir);
  throwsCode(() => inspectCollectionRemoval(noCsv.root, 'empty', ['x']), 'COLLECTION_REMOVAL_NOT_FOUND');

  mkdirSync(path.join(root, 'collections', 'dir-csv', 'data.csv'), { recursive: true });
  throwsCode(() => inspectCollectionRemoval(root, 'dir-csv', ['x']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  writeFileSync(path.join(root, 'collections', 'file-coll'), 'id\n');
  throwsCode(() => inspectCollectionRemoval(root, 'file-coll', ['x']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  mkdirSync(path.join(dir, 'folder.md'));
  throwsCode(() => inspectCollectionRemoval(root, collection, ['tea-001']), 'COLLECTION_REMOVAL_PATH_UNSAFE');
});

test('任何一级路径是符号链接都拒绝，且不写入链接目标', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'substrate-collection-outside-'));
  const outsideCsv = path.join(outside, 'data.csv');
  writeFileSync(outsideCsv, BASE_CSV);
  mkdirSync(path.join(outside, 'collections', 'tea-shelf'), { recursive: true });
  writeFileSync(path.join(outside, 'collections', 'tea-shelf', 'data.csv'), BASE_CSV);
  const outsideBefore = snapshot(outside);

  // 实例根本身是符号链接
  const real = makeInstance();
  const rootLink = path.join(outside, '..', `${path.basename(outside)}-root-link`);
  symlinkSync(real.root, rootLink);
  throwsCode(() => inspectCollectionRemoval(rootLink, 'tea-shelf', ['tea-001']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  // collections/ 是符号链接
  const a = mkdtempSync(path.join(tmpdir(), 'substrate-collection-removal-'));
  symlinkSync(path.join(outside, 'collections'), path.join(a, 'collections'));
  throwsCode(() => applyCollectionRemoval(a, 'tea-shelf', ['tea-001']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  // collections/<name>/ 是符号链接
  const b = mkdtempSync(path.join(tmpdir(), 'substrate-collection-removal-'));
  mkdirSync(path.join(b, 'collections'));
  symlinkSync(path.join(outside, 'collections', 'tea-shelf'), path.join(b, 'collections', 'tea-shelf'));
  throwsCode(() => applyCollectionRemoval(b, 'tea-shelf', ['tea-001']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  // data.csv 是符号链接
  const c = mkdtempSync(path.join(tmpdir(), 'substrate-collection-removal-'));
  mkdirSync(path.join(c, 'collections', 'tea-shelf'), { recursive: true });
  symlinkSync(outsideCsv, path.join(c, 'collections', 'tea-shelf', 'data.csv'));
  throwsCode(() => applyCollectionRemoval(c, 'tea-shelf', ['tea-001']), 'COLLECTION_REMOVAL_PATH_UNSAFE');

  assert.deepEqual(snapshot(outside), outsideBefore);
});

test('同级 Markdown 是符号链接：预检即失败，零写入（含纯缺失请求）', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'substrate-collection-outside-'));
  const target = path.join(outside, 'elsewhere.md');
  writeFileSync(target, '共 **4** 条\n');
  const { root, dir, collection } = makeInstance(BASE_CSV, { files: { 'README.md': README } });
  symlinkSync(target, path.join(dir, 'linked.md'));
  const before = snapshot(root);
  for (const ids of [['tea-001'], ['ghost']]) {
    throwsCode(() => inspectCollectionRemoval(root, collection, ids), 'COLLECTION_REMOVAL_PATH_UNSAFE');
    throwsCode(() => applyCollectionRemoval(root, collection, ids), 'COLLECTION_REMOVAL_PATH_UNSAFE');
  }
  assert.deepEqual(snapshot(root), before);
  assert.equal(readFileSync(target, 'utf8'), '共 **4** 条\n');
});

test('子目录（含符号链接子目录与分片内的链接页）不在扫描范围内', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'substrate-collection-outside-'));
  writeFileSync(path.join(outside, 'x.md'), '共 **4** 条\n');
  const { root, dir, collection } = makeInstance(BASE_CSV, { files: { 'shards/a.md': '**4** 条\n' } });
  symlinkSync(outside, path.join(dir, 'archive'));
  symlinkSync(path.join(outside, 'x.md'), path.join(dir, 'shards', 'linked.md'));
  const result = applyCollectionRemoval(root, collection, ['tea-001']);
  assert.deepEqual(result.changedPaths, ['collections/tea-shelf/data.csv']);
  assert.equal(readFileSync(path.join(outside, 'x.md'), 'utf8'), '共 **4** 条\n');
  assert.equal(readFileSync(path.join(dir, 'shards', 'a.md'), 'utf8'), '**4** 条\n');
});

test('畸形 CSV 一律拒绝且零写入', () => {
  const cases = [
    ['id,name\na,"unterminated\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,b"c\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,"b"c\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,"b" \n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na, "b"\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['name,title\na,b\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['ID,name\na,b\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,id\na,b\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,b,c\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,b\n   \n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\r\na,b\rc,d\r\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\na,b\0\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['\ufeff', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['\nid,name\na,b\n', 'COLLECTION_REMOVAL_CSV_INVALID'],
    ['id,name\nx,1\ny,2\nx,3\n', 'COLLECTION_REMOVAL_DUPLICATE_ID'],
    ['id,name\n"x",1\ny,2\nx,"multi\nline"\n', 'COLLECTION_REMOVAL_DUPLICATE_ID'],
    [Buffer.from([0x69, 0x64, 0x0a, 0xff, 0x0a]), 'COLLECTION_REMOVAL_ENCODING'],
  ];
  for (const [csv, code] of cases) {
    const { root, collection } = makeInstance(csv, { files: { 'README.md': '共 **2** 条\n' } });
    const before = snapshot(root);
    throwsCode(() => inspectCollectionRemoval(root, collection, ['y']), code);
    throwsCode(() => applyCollectionRemoval(root, collection, ['y']), code);
    assert.deepEqual(snapshot(root), before, `case ${JSON.stringify(String(csv))} 不应写入`);
  }
});
