import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexStore } from '../src/index-store.js';
import { createTools } from '../src/tools.js';
import { readContentId } from '../src/content-id.js';
import { readTier } from '../src/tier.js';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { testAdmissionForKind } from './helpers/admission.js';

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
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, admissionProvider: testAdmissionForKind });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, provider: fakeProvider({
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
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, admissionProvider: testAdmissionForKind });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, provider: fakeProvider({
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

// ==== M4.2 分层：tier-aware 检索 + 隔离-rejected 特例 ====

test('tier 过滤：默认只返 canonical；include=candidate 才现 candidate 页；无 tier 存量页默认可查', () => {
  const { dir, indexPath } = tmpInstance('idx-tier');
  writeFileSync(path.join(dir, 'knowledge', 'canon.md'),
    '---\ncontent_id: c0000001\ntier: canonical\ntitle: 正典页\ntype: knowledge\n---\n\n分层测试词 tierprobe 出现在 canonical 页。\n');
  writeFileSync(path.join(dir, 'knowledge', 'cand.md'),
    '---\ncontent_id: c0000002\ntier: candidate\ntitle: 候选页\ntype: knowledge\n---\n\n分层测试词 tierprobe 出现在 candidate 页。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    const def = store.query({ query: 'tierprobe', trust: 'high' });
    assert.ok(paths(def).includes('knowledge/canon.md'), '默认返 canonical 页');
    assert.ok(!paths(def).includes('knowledge/cand.md'), '默认不返 candidate 页');
    assert.ok(def.results.every((r) => r.tier === 'canonical'), '结果带 tier 字段，默认档全 canonical');
    // 迁移铁律：无 tier 存量页默认可查（视同 canonical）
    assert.ok(paths(store.query({ query: '牛排', trust: 'high' })).includes('knowledge/dining-sf.md'), '无 tier 存量页默认可查');
    // include=candidate：两者都现
    const inc = paths(store.query({ query: 'tierprobe', trust: 'high', include: 'candidate' }));
    assert.ok(inc.includes('knowledge/canon.md') && inc.includes('knowledge/cand.md'), 'include=candidate 两页都现');
  } finally { store.close(); }
});

test('索引把 skills/_incoming 强制标为 staging，只有 high+include=staging 可查', () => {
  const { dir, indexPath } = tmpInstance('idx-skill-staging');
  const zonesPath = path.join(dir, 'governance', 'zones.md');
  writeFileSync(zonesPath, readFileSync(zonesPath, 'utf8').replace('zones:\n', [
    'zones:', '  - id: skills', '    path: skills/', '    purpose: Skill 目录',
    '    privacy: private', '',
  ].join('\n')));
  const incoming = path.join(dir, 'skills', '_incoming', 'indexed-stage');
  mkdirSync(incoming, { recursive: true });
  writeFileSync(path.join(incoming, 'SKILL.md'), '---\ncontent_id: abcdef12\nname: indexed-stage\n---\n\nindexstageprobe 未晋升。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    assert.equal(store.query({ query: 'indexstageprobe', trust: 'high' }).results.length, 0);
    const high = store.query({ query: 'indexstageprobe', trust: 'high', include: 'staging' });
    assert.equal(high.results.length, 1);
    assert.equal(high.results[0].tier, 'staging');
    assert.equal(store.query({ query: 'indexstageprobe', trust: 'low', include: 'staging' }).results.length, 0);
  } finally { store.close(); }
});

test('隔离-rejected：仅 tier: rejected 的 inbox 件入索引；默认查不到、include=rejected+高信任可查；pending/held 任何档都查不到', () => {
  const { dir, indexPath } = tmpInstance('idx-rejected');
  mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  writeFileSync(path.join(dir, 'inbox', '_2026-07-05-rej.md'),
    '---\nid: rej1\ntype: inbox\ntier: rejected\nstatus: rejected\n---\n\n低价值件 rejquarantine 记一下天气。\n');
  writeFileSync(path.join(dir, 'inbox', '_2026-07-05-pend.md'),
    '---\nid: pend1\ntype: inbox\nstatus: pending\n---\n\n待判件 pendquarantine 龙虾。\n');
  writeFileSync(path.join(dir, 'inbox', '_2026-07-05-held.md'),
    '---\nid: held1\ntype: inbox\nstatus: held\n---\n\n待定夺件 heldquarantine 松茸。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    for (const trust of ['low', 'high']) {
      assert.equal(store.query({ query: 'rejquarantine', trust }).results.length, 0, `${trust} 默认档不返 rejected 隔离件`);
    }
    assert.ok(paths(store.query({ query: 'rejquarantine', trust: 'high', include: 'rejected' })).includes('inbox/_2026-07-05-rej.md'),
      'include=rejected 高信任可查隔离件');
    assert.equal(store.query({ query: 'rejquarantine', trust: 'low', include: 'rejected' }).results.length, 0,
      '隔离件仅高信任可见（与 tools.js 未注册 zone 收紧两面一致）');
    // pending / held：任何 trust、任何 include 都查不到（M4.1 不变式：永不入索引）
    for (const trust of ['low', 'high']) {
      for (const include of [undefined, 'candidate', 'rejected', 'candidate,rejected']) {
        assert.equal(store.query({ query: 'pendquarantine', trust, include }).results.length, 0, `pending 不得漏（trust=${trust} include=${include}）`);
        assert.equal(store.query({ query: 'heldquarantine', trust, include }).results.length, 0, `held 不得漏（trust=${trust} include=${include}）`);
      }
    }
  } finally { store.close(); }
});

test('隔离-rejected 增量：updatePage 只纳入 tier: rejected 的 inbox 件；pending 件即便直接 updatePage 也不入', () => {
  const { dir, indexPath } = tmpInstance('idx-rej-incr');
  mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  const rejRel = 'inbox/_2026-07-05-r.md';
  const pendRel = 'inbox/_2026-07-05-p.md';
  writeFileSync(path.join(dir, rejRel), '---\nid: r\ntype: inbox\ntier: rejected\nstatus: rejected\n---\n\n增量拒件 incrrej 一段。\n');
  writeFileSync(path.join(dir, pendRel), '---\nid: p\ntype: inbox\nstatus: pending\n---\n\n增量待判 incrpend 一段。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    store.updatePage(rejRel);
    store.updatePage(pendRel);
    assert.ok(paths(store.query({ query: 'incrrej', trust: 'high', include: 'rejected' })).includes(rejRel), 'rejected 增量入索引');
    for (const trust of ['low', 'high']) {
      for (const include of [undefined, 'rejected']) {
        assert.equal(store.query({ query: 'incrpend', trust, include }).results.length, 0, 'pending 增量不得入索引');
      }
    }
  } finally { store.close(); }
});

test('端到端：keeper 拒收低价值件 → 隔离-rejected 入索引；默认检索落空、include=rejected 可查', async () => {
  const { work, indexPath } = gitInstance();
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, admissionProvider: testAdmissionForKind });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, provider: fakeProvider({
      disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'x',
      summary: '闲聊无留存价值', confidence: 0.9, reject_reason: '一次性闲聊，无留存价值',
    }), notifier: fakeNotifier(), audit: () => {}, doctor: false, indexStore,
  });
  try {
    indexStore.rebuild();
    const receipt = inbox.addEntry({ kind: 'save', content: '今天真无聊 losslessprobe 哈哈。', client: 'cc-test' });
    await receipt.synced;
    const result = await keeper.processPending();
    assert.equal(result.rejected, 1);
    assert.ok(existsSync(path.join(work, receipt.path)), '拒收件不丢（lossless）');
    assert.equal(indexStore.query({ query: 'losslessprobe', trust: 'high' }).results.length, 0, '默认检索不含 rejected');
    const hi = indexStore.query({ query: 'losslessprobe', trust: 'high', include: 'rejected' });
    assert.ok(hi.results.some((r) => r.path === receipt.path), 'include=rejected 高信任可查到隔离件');
  } finally { indexStore.close(); }
});

test('缺陷2a：手写 status: pending + tier: rejected 的件不得入索引（隔离-rejected 需 status/tier 双条件）', () => {
  const { dir, indexPath } = tmpInstance('idx-forge');
  mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  writeFileSync(path.join(dir, 'inbox', '_2026-07-05-forge.md'),
    '---\nid: forge\ntype: inbox\ntier: rejected\nstatus: pending\n---\n\n伪造件 forgequarantine 想借 tier: rejected 混进索引。\n');
  const store = createIndexStore({ instanceDir: dir, indexPath });
  try {
    store.rebuild();
    for (const trust of ['low', 'high']) {
      for (const include of [undefined, 'rejected', 'candidate,rejected']) {
        assert.equal(store.query({ query: 'forgequarantine', trust, include }).results.length, 0,
          `status:pending + tier:rejected 不得入索引（trust=${trust} include=${include}）`);
      }
    }
    // 直接 updatePage 也不入（增量口同守双条件）
    store.updatePage('inbox/_2026-07-05-forge.md');
    assert.equal(store.query({ query: 'forgequarantine', trust: 'high', include: 'rejected' }).results.length, 0);
  } finally { store.close(); }
});

test('缺陷2b：拒→复核→复位——resolveEntry 清 tier 行并刷索引；默认档与 include=rejected 都查不到残留', async () => {
  const { work, indexPath } = gitInstance();
  const writer = createWriter({ instanceDir: work });
  const indexStore = createIndexStore({ instanceDir: work, indexPath });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, indexStore, nativeReg, admissionProvider: testAdmissionForKind });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, provider: fakeProvider({
      disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'x',
      summary: '闲聊无留存价值', confidence: 0.9, reject_reason: '一次性闲聊，无留存价值',
    }), notifier: fakeNotifier(), audit: () => {}, doctor: false, indexStore,
  });
  try {
    indexStore.rebuild();
    const receipt = inbox.addEntry({ kind: 'save', content: '今天真无聊 staleprobe 哈哈。', client: 'cc-test' });
    await receipt.synced;
    await keeper.processPending(); // → keeper 主动拒收 → 隔离-rejected 入索引
    assert.ok(indexStore.query({ query: 'staleprobe', trust: 'high', include: 'rejected' }).results.some((r) => r.path === receipt.path),
      '拒收后 include=rejected 高信任可查到隔离件');
    // 主人复核复位 pending
    const resolved = inbox.resolveEntry({ id: receipt.id, ruling: '这条留着，进 todo' });
    await resolved.synced;
    const raw = readFileSync(path.join(work, receipt.path), 'utf8');
    assert.equal(readTier(raw), 'canonical', '复位后 tier: rejected 旗标应被清掉（视同 canonical）');
    assert.match(raw, /status: pending/);
    // 索引不得残留旧的隔离-rejected 行：默认档与 include=rejected 都查不到
    for (const include of [undefined, 'rejected']) {
      assert.equal(indexStore.query({ query: 'staleprobe', trust: 'high', include }).results.length, 0,
        `复位后派生索引不得残留（include=${include}）`);
    }
  } finally { indexStore.close(); }
});

test('缺陷4：tier 写法变体（单双引号/大小写/多空格）在 index 与 search 两面结果一致', async () => {
  const { dir, indexPath } = tmpInstance('idx-tier-variants');
  const variants = {
    'knowledge/v-dq.md': '---\ntier: "candidate"\ntitle: 双引号\ntype: knowledge\n---\n\n变体词 tiervariant 双引号。\n',
    'knowledge/v-sq.md': "---\ntier: 'candidate'\ntitle: 单引号\ntype: knowledge\n---\n\n变体词 tiervariant 单引号。\n",
    'knowledge/v-uc.md': '---\ntier: CANDIDATE\ntitle: 大写\ntype: knowledge\n---\n\n变体词 tiervariant 大写。\n',
    'knowledge/v-sp.md': '---\ntier:    candidate   \ntitle: 多空格\ntype: knowledge\n---\n\n变体词 tiervariant 多空格。\n',
  };
  const all = Object.keys(variants).sort();
  for (const [rel, body] of Object.entries(variants)) writeFileSync(path.join(dir, rel), body);
  const store = createIndexStore({ instanceDir: dir, indexPath });
  const tools = createTools({ instanceDir: dir });
  try {
    store.rebuild();
    // 默认档：四个变体全被当 candidate（引号/大小写/空格无关）→ 两面都查不到
    const idxDef = paths(store.query({ query: 'tiervariant', trust: 'high' })).filter((p) => p.startsWith('knowledge/v-'));
    const srchDef = (await tools.search({ query: 'tiervariant', trust: 'high' })).results.map((r) => r.path).filter((p) => p.startsWith('knowledge/v-'));
    assert.deepEqual(idxDef, [], 'index 默认档不含任何变体');
    assert.deepEqual([...new Set(srchDef)], [], 'search 默认档同样不含任何变体（两面一致）');
    // include=candidate：四个变体全现，且 index 与 search 命中集合一致
    const idxC = [...new Set(paths(store.query({ query: 'tiervariant', trust: 'high', include: 'candidate' })).filter((p) => p.startsWith('knowledge/v-')))].sort();
    const srchC = [...new Set((await tools.search({ query: 'tiervariant', trust: 'high', include: 'candidate' })).results.map((r) => r.path).filter((p) => p.startsWith('knowledge/v-')))].sort();
    assert.deepEqual(idxC, all, 'index include=candidate 现全部四个变体');
    assert.deepEqual(srchC, all, 'search 与 index 两面命中集合一致');
  } finally { store.close(); }
});
