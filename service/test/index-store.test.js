import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexStore } from '../src/index-store.js';
import { readContentId } from '../src/content-id.js';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

// 纯索引测试用的实例（无需 git）：copy fixture + 造一个含中文的知识页（带 content_id）
function tmpInstance(tag) {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`));
  const dir = path.join(base, 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  writeFileSync(path.join(dir, 'knowledge', 'dining-sf.md'),
    '---\ncontent_id: 11112222\ntitle: 旧金山餐厅笔记\ntype: knowledge\n---\n\n旧金山牛排餐厅推荐：这家的 wagyu 和牛很棒，牛排火候到位。\n');
  return { dir, indexPath: path.join(base, 'idx.sqlite') };
}

const paths = (r) => r.results.map((x) => x.path);
const norm = (r) => r.results.map((x) => ({ path: x.path, content_id: x.content_id, line: x.line, snippet: x.snippet }));

// ==== 命中：中文两字词 / 三字词 / 英文 / 混合 ====

test('检索命中：中文两字词「牛排」、三字词「旧金山」、英文「wagyu」', () => {
  const { dir, indexPath } = tmpInstance('idx-hit');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    for (const q of ['牛排', '旧金山', 'wagyu', 'WAGYU']) {
      const r = store.query({ query: q, trust: 'high' });
      assert.ok(r.results.length >= 1, `「${q}」应命中`);
      assert.ok(paths(r).includes('knowledge/dining-sf.md'), `「${q}」应命中 dining-sf`);
    }
    // content_id 随命中带回
    const r = store.query({ query: '牛排', trust: 'high' });
    assert.equal(r.results[0].content_id, '11112222');
    assert.equal(typeof r.results[0].score, 'number');
  } finally { store.close(); }
});

test('检索命中：既有中文页「咖啡」（标题里）与「耶加雪菲」（正文）', () => {
  const { dir, indexPath } = tmpInstance('idx-coffee');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    assert.ok(paths(store.query({ query: '咖啡', trust: 'high' })).includes('knowledge/coffee-brewing.md'));
    assert.ok(paths(store.query({ query: '耶加雪菲', trust: 'high' })).includes('knowledge/coffee-brewing.md'));
  } finally { store.close(); }
});

// ==== ACL：与现有 search 相同的 canRead 过滤 ====

test('ACL：memory 为 sensitive，低信任查不到、高信任查得到', () => {
  const { dir, indexPath } = tmpInstance('idx-acl');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const low = store.query({ query: '素食', trust: 'low' });
    assert.equal(low.results.length, 0, '低信任不得见 memory 敏感区');
    const high = store.query({ query: '素食', trust: 'high' });
    assert.ok(high.results.some((x) => x.path.startsWith('memory/about-owner/')), '高信任可见');
  } finally { store.close(); }
});

test('zone 过滤：query 限定 knowledge 只返 knowledge 页；未知 zone 报错', () => {
  const { dir, indexPath } = tmpInstance('idx-zone');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const inK = store.query({ query: '牛排', zone: 'knowledge', trust: 'high' });
    assert.ok(inK.results.length >= 1 && inK.results.every((x) => x.path.startsWith('knowledge/')));
    assert.equal(store.query({ query: '牛排', zone: 'memory', trust: 'high' }).results.length, 0);
    assert.throws(() => store.query({ query: 'x', zone: 'nope', trust: 'high' }), /没有叫 nope/);
  } finally { store.close(); }
});

// ==== 单字 CJK：降级子串扫描 ====

test('单字 CJK 查询「水」：bigram 索引无单字 token → 降级 raw 子串扫描仍命中', () => {
  const { dir, indexPath } = tmpInstance('idx-single');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const r = store.query({ query: '水', trust: 'high' });
    assert.ok(paths(r).includes('knowledge/coffee-brewing.md'), '「水」应经降级命中「水温」行');
  } finally { store.close(); }
});

// ==== 铁律：删索引 → 重建 → 结果一致；重建幂等 ====

test('铁律：重建幂等 + 删索引文件后自动重建，查询结果一致', () => {
  const { dir, indexPath } = tmpInstance('idx-rebuild');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  let before;
  try {
    before = norm(store.query({ query: '牛排', trust: 'high' }));
    assert.ok(before.length >= 1);
    // 重建幂等：再建一次，结果不变
    store.rebuild();
    assert.deepEqual(norm(store.query({ query: '牛排', trust: 'high' })), before);
  } finally { store.close(); }

  // 删掉索引文件 → 新开 store → 查询触发自动重建 → 结果与删前一致
  rmSync(indexPath, { force: true });
  assert.ok(!existsSync(indexPath), '索引文件已删');
  const store2 = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const after = norm(store2.query({ query: '牛排', trust: 'high' })); // 首次查询触发自动重建
    assert.ok(existsSync(indexPath), '查询后索引文件已自动重建');
    assert.deepEqual(after, before, '删索引→重建→查询结果一致（无独有正典）');
  } finally { store2.close(); }
});

test('索引文件落在实例目录之外（不污染 git 工作树）', () => {
  const { dir, indexPath } = tmpInstance('idx-loc');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    assert.ok(existsSync(indexPath));
    assert.ok(!indexPath.startsWith(path.resolve(dir) + path.sep), '索引不得落进实例目录内');
  } finally { store.close(); }
});

// ==== 增量：单页更新 / 删除 ====

test('增量 updatePage / removePage：改页后新词可查、删页后消失', () => {
  const { dir, indexPath } = tmpInstance('idx-incr');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    assert.equal(store.query({ query: '松露', trust: 'high' }).results.length, 0);
    // 改页：追加含「松露」的新行 → 增量更新单页
    const rel = 'knowledge/dining-sf.md';
    writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8') + '\n还有一道松露意面也不错。\n');
    store.updatePage(rel);
    assert.ok(paths(store.query({ query: '松露', trust: 'high' })).includes(rel), '增量后「松露」可查');
    assert.ok(paths(store.query({ query: '牛排', trust: 'high' })).includes(rel), '旧内容仍在');
    // 删页：removePage 后该页所有行消失
    store.removePage(rel);
    assert.equal(store.query({ query: '牛排', trust: 'high' }).results.length, 0);
  } finally { store.close(); }
});

// ==== 端到端：keeper 归档 → 新页带 content_id + 索引增量刷新 ====

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}
function gitInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-idx-keeper-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  return { work, indexPath: path.join(base, 'idx.sqlite') };
}
function fakeProvider(decision) {
  return { judge: async (req) => ({ json: decision, model: req.escalate ? 'pro' : 'flash', usage: { total_tokens: 1 } }) };
}
const fakeNotifier = () => ({ notify: async () => ({ ok: true }) });

// ==== 缺陷1（治理边界）：隔离区/系统区永不入索引 ====

test('缺陷1：inbox/keeper-feedback/governance/skills 隔离系统区永不入索引（低/高信任都命不中）', () => {
  const { dir, indexPath } = tmpInstance('idx-quarantine');
  mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  writeFileSync(path.join(dir, 'inbox', '_2026-07-05-x.md'),
    '---\nstatus: pending\n---\n\n隔离件机密 quarantinesecret 龙虾刺身待判。\n');
  mkdirSync(path.join(dir, 'keeper-feedback'), { recursive: true });
  writeFileSync(path.join(dir, 'keeper-feedback', '_cases.md'),
    '---\ntitle: 判例\n---\n\n判例机密 feedbacksecret 松茸。\n');
  // governance/zones.md（含「分区注册表」）与 skills/*.py 已在 fixture 里
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    for (const trust of ['low', 'high']) {
      assert.equal(store.query({ query: 'quarantinesecret', trust }).results.length, 0, `${trust} 不得命中 inbox 隔离件`);
      assert.equal(store.query({ query: '龙虾', trust }).results.length, 0, `${trust} 不得命中 inbox 隔离件正文`);
      assert.equal(store.query({ query: 'feedbacksecret', trust }).results.length, 0, `${trust} 不得命中 keeper-feedback`);
      assert.equal(store.query({ query: '分区注册表', trust }).results.length, 0, `${trust} 不得命中 governance`);
    }
    // 对照：注册 zone 的知识页仍可检索
    assert.ok(store.query({ query: '牛排', trust: 'high' }).results.length >= 1, '注册 zone 仍可检索');
  } finally { store.close(); }
});

test('缺陷1：updatePage 对未注册 zone 的路径不入索引（隔离件不因增量刷新泄漏）', () => {
  const { dir, indexPath } = tmpInstance('idx-quarantine-incr');
  mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  const rel = 'inbox/_2026-07-05-y.md';
  writeFileSync(path.join(dir, rel), '---\nstatus: pending\n---\n\n隔离增量词 incrsecret。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    store.updatePage(rel); // 即便被直接调用也不得把隔离件并进索引
    for (const trust of ['low', 'high']) {
      assert.equal(store.query({ query: 'incrsecret', trust }).results.length, 0, `${trust} updatePage 不得纳入未注册 zone`);
    }
  } finally { store.close(); }
});

// ==== 缺陷2（红线）：INDEX_PATH 不得指进实例 git 工作树 ====

test('缺陷2：INDEX_PATH 落在实例目录内直接拒绝（:memory: 与实例外正常）', () => {
  const { dir } = tmpInstance('idx-guard');
  assert.throws(() => createIndexStore({ instanceDir: dir, indexPath: path.join(dir, 'recall-index.sqlite') }),
    /实例|工作树|instance/i, '索引落实例根应拒绝');
  assert.throws(() => createIndexStore({ instanceDir: dir, indexPath: path.join(dir, 'knowledge', 'idx.sqlite') }),
    /实例|工作树|instance/i, '索引落实例子目录应拒绝');
  // 实例外正常
  const outside = createIndexStore({ instanceDir: dir, indexPath: path.join(path.dirname(path.resolve(dir)), 'idx.sqlite') });
  outside.close();
  // :memory: 豁免
  const mem = createIndexStore({ instanceDir: dir, indexPath: ':memory:' });
  mem.close();
});

test('缺陷2：默认 INDEX_PATH（env）指进实例也拒绝', () => {
  const { dir } = tmpInstance('idx-guard-env');
  const prev = process.env.INDEX_PATH;
  process.env.INDEX_PATH = path.join(dir, 'sneaky.sqlite');
  try {
    assert.throws(() => createIndexStore({ instanceDir: dir }), /实例|工作树|instance/i);
  } finally {
    if (prev === undefined) delete process.env.INDEX_PATH; else process.env.INDEX_PATH = prev;
  }
});

// ==== 缺陷4：打开中的索引文件被删后仍能重建 ====

test('缺陷4：索引文件被删（连接 fd 仍活）后，下次操作探测缺失→重建，新旧内容都可检索', () => {
  const { dir, indexPath } = tmpInstance('idx-unlink');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    assert.ok(store.query({ query: '牛排', trust: 'high' }).results.length >= 1);
    assert.ok(existsSync(indexPath));
    rmSync(indexPath, { force: true }); // 删掉正在使用的索引文件
    assert.ok(!existsSync(indexPath), '文件已删');
    const rel = 'knowledge/dining-sf.md';
    writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8') + '\n新增松露意面一道。\n');
    store.updatePage(rel); // 应探测到文件不在→关旧连接重建
    assert.ok(existsSync(indexPath), '索引文件已重建');
    assert.ok(paths(store.query({ query: '松露', trust: 'high' })).includes(rel), '重建后新内容可检索');
    assert.ok(paths(store.query({ query: '牛排', trust: 'high' })).includes(rel), '旧内容仍在');
  } finally { store.close(); }
});

// ==== 缺陷8：ACL 预过滤进 SQL，敏感命中不挤掉可读结果 ====

test('缺陷8：大量敏感命中 + 1 条公开命中，低信任仍拿到公开那条（不被 LIMIT 挤空）', () => {
  const { dir, indexPath } = tmpInstance('idx-acl-limit');
  const memLines = Array.from({ length: 20 }, () => '蓝莓').join('\n'); // 短行 → bm25 排前
  writeFileSync(path.join(dir, 'memory', 'about-owner', 'hobbies.md'),
    `---\ntitle: 记忆\ntype: memory\n---\n\n${memLines}\n`);
  writeFileSync(path.join(dir, 'knowledge', 'berry.md'),
    '---\ncontent_id: 33334444\ntitle: 公开蓝莓笔记\ntype: knowledge\n---\n\n这是一段较长的公开知识笔记正文，其中也谈到了 蓝莓 相关的种植与风味细节问题很多。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    const low = store.query({ query: '蓝莓', trust: 'low', limit: 3 });
    assert.ok(low.results.some((r) => r.path === 'knowledge/berry.md'),
      '低信任应拿到公开命中，不因敏感命中占满 LIMIT 而假落空');
    assert.ok(!low.results.some((r) => r.path.startsWith('memory/')), '低信任结果不含敏感区');
    const high = store.query({ query: '蓝莓', trust: 'high', limit: 50 });
    assert.ok(high.results.some((r) => r.path === 'knowledge/berry.md'));
    assert.ok(high.results.some((r) => r.path.startsWith('memory/')));
  } finally { store.close(); }
});

test('keeper 建页：新页写 content_id，且索引增量刷新后可检索到新页', async () => {
  const { work, indexPath } = gitInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const keeper = createKeeper({
    instanceDir: work, writer, provider: fakeProvider({
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'espresso-basics', title: '意式浓缩要点', summary: '意式浓缩', confidence: 0.95,
    }), notifier: fakeNotifier(), audit: () => {}, doctor: false, indexStore,
  });
  try {
    indexStore.rebuild(); // 建页前先全量建（新页此时不在库，用于验证增量路径）
    assert.equal(indexStore.query({ query: '意式浓缩', trust: 'high' }).results.length, 0);

    const receipt = inbox.addEntry({ kind: 'save', content: '意式浓缩 92 度 9bar 萃取。', client: 'cc-test' });
    await receipt.synced;
    const result = await keeper.processPending();
    assert.equal(result.filed, 1);

    // 新页落盘带 content_id（executor）
    const page = readFileSync(path.join(work, 'knowledge', 'espresso-basics.md'), 'utf8');
    assert.match(readContentId(page) ?? '', /^[0-9a-f]{8}$/, '新页应带 8 位 content_id');

    // keeper 单写口的增量刷新（refreshIndex）已把新页并进索引
    const r = indexStore.query({ query: '意式浓缩', trust: 'high' });
    assert.ok(paths(r).includes('knowledge/espresso-basics.md'), '归档后新页应可检索');
    assert.equal(r.results[0].content_id, readContentId(page));
  } finally { indexStore.close(); }
});

// ==== 缺陷3：keeper 收藏 upsert 后，增量刷新纳入新 csv 行（.csv 不再被跳过）====

test('缺陷3：keeper upsert_row 后索引增量刷新纳入新 csv 行', async () => {
  const { work, indexPath } = gitInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const keeper = createKeeper({
    instanceDir: work, writer, provider: fakeProvider({
      disposition: 'canonical', zone: 'collections', action: 'upsert_row',
      target: 'restaurants', fields: { name: '松露主题餐厅', city: '样例城', cuisine: '法餐' },
      summary: '收藏餐厅', confidence: 0.95,
    }), notifier: fakeNotifier(), audit: () => {}, doctor: false, indexStore,
  });
  try {
    indexStore.rebuild();
    assert.equal(indexStore.query({ query: '松露主题', trust: 'high' }).results.length, 0);

    const receipt = inbox.addEntry({ kind: 'collection', payload: { name: 'restaurants', row: { name: '松露主题餐厅' } }, client: 'cc-test' });
    await receipt.synced;
    const result = await keeper.processPending();
    assert.equal(result.filed, 1, 'upsert 应 filed');

    const r = indexStore.query({ query: '松露主题', trust: 'high' });
    assert.ok(r.results.some((x) => x.path === 'collections/restaurants/data.csv'), '新 csv 行应可检索（.csv 已随增量刷新）');
  } finally { indexStore.close(); }
});
