import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../src/tools.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
let instanceDir;
let tools;

// 在临时实例里现造一个收藏 CSV（M4.7 大表/字节预算/翻页用例需要比 fixture 更大的表）。
// 沿用 tier 用例「往 temp 实例 writeFileSync 注入」的风格，不污染仓库 fixture。
function writeCollection(name, header, rows) {
  const dir = path.join(instanceDir, 'collections', name);
  mkdirSync(dir, { recursive: true });
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
  writeFileSync(path.join(dir, 'data.csv'), csv);
}

before(() => {
  // 拷到临时目录，以便注入 .git/ 等 fixture 里没法提交的东西
  instanceDir = mkdtempSync(path.join(tmpdir(), 'substrate-instance-'));
  cpSync(fixtureDir, instanceDir, { recursive: true });
  mkdirSync(path.join(instanceDir, '.git'));
  writeFileSync(path.join(instanceDir, '.git', 'leak.md'), '耶加雪菲 secret-git-internal');
  tools = createTools({ instanceDir });
});

test('search：命中知识页，返回路径+片段', async () => {
  const { results } = await tools.search({ query: '耶加雪菲', trust: 'high' });
  assert.ok(results.length >= 1);
  const hit = results.find((r) => r.path === 'knowledge/coffee-brewing.md');
  assert.ok(hit, 'knowledge/coffee-brewing.md 应命中');
  assert.match(hit.snippet, /耶加雪菲/);
  assert.ok(!results.some((r) => r.path.startsWith('.git')), '.git 不应出现在结果里');
});

test('search：zone 过滤', async () => {
  const inTodo = await tools.search({ query: 'Alex', zone: 'todo', trust: 'high' });
  assert.equal(inTodo.results.length, 0);
  const inMemory = await tools.search({ query: 'Alex', zone: 'memory', trust: 'high' });
  assert.ok(inMemory.results.some((r) => r.path.startsWith('memory/about-owner/')));
});

test('search：低信任看不到 sensitive 区内容', async () => {
  const { results } = await tools.search({ query: '橡皮鸭', trust: 'low' });
  assert.equal(results.length, 0);
});

test('缺陷1：search 只扫注册 zone——inbox pending 件任何信任任何档都命不中；governance 从 search 消失', async () => {
  const inboxDir = path.join(instanceDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(path.join(inboxDir, '_2026-07-05-q.md'),
    '---\nstatus: pending\n---\n\n隔离件 searchquarantine 龙虾待判。\n');
  // pending 待判件：任何 trust、任何 include 都不得命中（不变式：pending/held 任何档任何组合绝不可查）。
  // 关键回归：high + 默认档也不得见（旧行为「未注册 zone 仅 high 放行」正是缺陷 1 的根）。
  for (const trust of ['low', 'high']) {
    for (const include of [undefined, 'rejected', 'candidate,rejected']) {
      const { results } = await tools.search({ query: 'searchquarantine', trust, include });
      assert.ok(!results.some((r) => r.path.startsWith('inbox/')),
        `pending 隔离件不得被 search 命中（trust=${trust} include=${include}）`);
    }
  }
  // governance 未注册区（zones.md）：连高信任默认档也从 search 消失（只扫注册 zone）。
  const gov = await tools.search({ query: '分区注册表', trust: 'high' });
  assert.ok(!gov.results.some((r) => r.path.startsWith('governance/')),
    'governance 从 search 消失（readPage/getContext 是另一条通路、各自把关，不受影响）');
});

test('read_page：读页全文', async () => {
  const { content } = await tools.readPage({ path: 'todo/owner.md', trust: 'high' });
  assert.match(content, /柠檬树/);
});

test('read_page：路径穿越/绝对路径/.git 一律拒绝', async () => {
  await assert.rejects(() => tools.readPage({ path: '../../etc/passwd', trust: 'high' }));
  await assert.rejects(() => tools.readPage({ path: '/etc/passwd', trust: 'high' }));
  await assert.rejects(() => tools.readPage({ path: '.git/leak.md', trust: 'high' }));
});

test('read_page：sensitive 区按信任级放行', async () => {
  await assert.rejects(
    () => tools.readPage({ path: 'memory/about-owner/core-summary.md', trust: 'low' }),
    /sensitive|敏感/
  );
  const { content } = await tools.readPage({ path: 'memory/about-owner/core-summary.md', trust: 'high' });
  assert.match(content, /Alex/);
});

test('get_context：跑实例 vendored 的 render-context.py；低信任拒绝', async () => {
  const { content } = await tools.getContext({ trust: 'high' });
  assert.match(content, /Alex/);
  await assert.rejects(() => tools.getContext({ trust: 'low' }), /sensitive|敏感/);
});

test('get_context：digest v2 化——剥掉 v1 锈迹段，保留记忆与库地图', async () => {
  const { content } = await tools.getContext({ trust: 'high' });
  // 该留的：主人核心记忆、记忆目录、各区速览（zone/canonical 描述行）
  assert.match(content, /关于主人（核心）/);
  assert.match(content, /Alex/);
  assert.match(content, /库里有什么/);
  assert.match(content, /zone: collections/);
  assert.match(content, /canonical: 每个收藏的行式主表/);
  // 该剥的：v1 技能路由表、v1 房规整段（含 wire-context/SKILL.md 指令）
  assert.ok(!content.includes('何时用哪个 skill'), 'v1 路由表段应整段剥除');
  assert.ok(!content.includes('房规（substrate 常驻接入）'), 'v1 房规段应整段剥除（v2 房规由 DIGEST_RULES 下发）');
  assert.ok(!content.includes('wire-context'), 'v1 刷新指令不得残留');
  // 该剥的：Packet 里指挥直接改文件的操作行（维护 skill / 写前查 / 写后更新）
  assert.ok(!content.includes('维护 skill'), 'Packet 的维护 skill 行应剥除');
  assert.ok(!content.includes('写前查'), 'Packet 的写前查行应剥除（v2 写入走 MCP+inbox）');
  assert.ok(!content.includes('写后更新'), 'Packet 的写后更新行应剥除');
  // 该改写的：substrate-* 技能引用换成 MCP 工具口径
  assert.ok(!content.includes('substrate-memory'), 'substrate-memory 技能引用应改写为 read_page');
  assert.match(content, /read_page/);
});

test('todo_list：默认返回 owner.md，并告知还有哪些清单', async () => {
  const r = await tools.todoList();
  assert.match(r.content, /柠檬树/);
  assert.match(r.content, /自行车/);
  assert.equal(r.list, 'owner');
  assert.deepEqual(r.other_lists, ['curio-todo']);
});

test('todo_list：list 参数读其他清单（容忍简称）；未知清单报可读错误', async () => {
  const exact = await tools.todoList({ list: 'curio-todo' });
  assert.match(exact.content, /X 平台集成/);
  const fuzzy = await tools.todoList({ list: 'curio' });
  assert.equal(fuzzy.list, 'curio-todo');
  await assert.rejects(() => tools.todoList({ list: 'nope' }), /owner|curio/);
});

test('collections_search：关键词过滤行，带引号逗号字段解析正确', async () => {
  const { rows } = await tools.collectionsSearch({ name: 'restaurants', query: '川菜' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '样例川菜馆');
  assert.equal(rows[0].notes, '麻婆豆腐好吃, 环境一般');
});

test('collections_search：空 query 返回全部行；未知收藏名报可读错误', async () => {
  const { rows } = await tools.collectionsSearch({ name: 'restaurants', query: '' });
  assert.equal(rows.length, 2);
  await assert.rejects(() => tools.collectionsSearch({ name: 'nope', query: 'x' }), /restaurants/);
});

// ==== M4.7 collections_search v2：按列过滤 / 列投影 / 分页 / 字节预算 / truncated 契约 ====

test('M4.7 向后兼容：{name,query} 旧形态返回形状与语义不变（含 total=收藏总行数，无 truncated）', async () => {
  const r = await tools.collectionsSearch({ name: 'restaurants', query: '' });
  assert.deepEqual(r.columns, ['id', 'name', 'city', 'cuisine', 'status', 'notes']);
  assert.equal(r.total, 2);          // total 仍是收藏总行数（不因过滤改语义）
  assert.equal(r.rows.length, 2);
  assert.ok(!('truncated' in r), '未截断不带 truncated（与 search 风格一致）');
  // 旧 query 仍是全字段大小写不敏感 contains
  const q = await tools.collectionsSearch({ name: 'restaurants', query: '川菜' });
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].name, '样例川菜馆');
});

test('M4.7 where：按列子串过滤（大小写不敏感）；未知列报错并列出可用列，不回显行数据', async () => {
  const hit = await tools.collectionsSearch({ name: 'restaurants', where: { cuisine: '日料' } });
  assert.equal(hit.rows.length, 1);
  assert.equal(hit.rows[0].name, 'Demo Ramen');
  // 大小写不敏感
  const ci = await tools.collectionsSearch({ name: 'restaurants', where: { name: 'demo ramen' } });
  assert.equal(ci.rows.length, 1);
  // 未知列：报错列出可用列、且不出现任何行数据
  await assert.rejects(
    () => tools.collectionsSearch({ name: 'restaurants', where: { nosuchcol: 'x' } }),
    (e) => /nosuchcol/.test(e.message) && /cuisine/.test(e.message) && !/样例川菜馆/.test(e.message)
  );
  // 原型污染防御：__proto__/constructor 作为列名 = 未知列被拒（绝不当对象键索引）。
  // 用 JSON.parse 造出真实的 own key '__proto__'（对象字面量 { __proto__: } 会走原型设置器，测不到）。
  await assert.rejects(
    () => tools.collectionsSearch({ name: 'restaurants', where: JSON.parse('{"__proto__":"x"}') }),
    /没有这些列|__proto__/
  );
});

test('M4.7 columns：列投影只返所选列；未知列报错', async () => {
  const r = await tools.collectionsSearch({ name: 'restaurants', columns: ['name', 'city'] });
  assert.equal(r.rows.length, 2);
  assert.deepEqual(Object.keys(r.rows[0]), ['name', 'city']);
  assert.deepEqual(r.columns, ['name', 'city']);
  await assert.rejects(
    () => tools.collectionsSearch({ name: 'restaurants', columns: ['name', 'bogus'] }),
    (e) => /bogus/.test(e.message) && /name/.test(e.message)
  );
});

test('M4.7 query + where 同时给 = AND', async () => {
  // query 命中两行（空=全部），where 再收窄到 cuisine=川菜
  const r = await tools.collectionsSearch({ name: 'restaurants', query: 'demo', where: { cuisine: '日料' } });
  // 'demo' 全字段模糊命中 Demo Ramen 与 demo-sichuan(id) 两行；where cuisine=日料 只留 Demo Ramen
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].name, 'Demo Ramen');
});

test('M4.7 limit/offset 分页 + truncated 四件套 + offset 越界空返回', async () => {
  const header = ['id', 'name'];
  const rows = Array.from({ length: 120 }, (_, i) => [`c${i}`, `row-${i}`]);
  writeCollection('cities', header, rows);

  // 默认 limit=50，第一页：truncated 四件套齐备
  const p1 = await tools.collectionsSearch({ name: 'cities' });
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.total, 120);
  assert.equal(p1.truncated, true);
  assert.equal(p1.returned, 50);
  assert.equal(p1.next_offset, 50);
  assert.match(p1.hint, /where|columns|limit|翻页|offset/);

  // 翻到末页：offset=100,limit=50 → 20 行，且不再 truncated
  const last = await tools.collectionsSearch({ name: 'cities', offset: 100, limit: 50 });
  assert.equal(last.rows.length, 20);
  assert.ok(!last.truncated, '末页不再 truncated');
  assert.equal(last.rows[0].name, 'row-100');

  // offset 越界：空 rows 而非报错
  const over = await tools.collectionsSearch({ name: 'cities', offset: 999 });
  assert.equal(over.rows.length, 0);
  assert.ok(!over.truncated);

  // limit 非法（0/负/非整）报友好错误；offset 负数同理
  await assert.rejects(() => tools.collectionsSearch({ name: 'cities', limit: 0 }), /limit/);
  await assert.rejects(() => tools.collectionsSearch({ name: 'cities', limit: -3 }), /limit/);
  await assert.rejects(() => tools.collectionsSearch({ name: 'cities', offset: -1 }), /offset/);
});

test('M4.7 limit 超上限被夹到 MAX_LIMIT（配合 truncated 仍可翻页，而非硬报错）', async () => {
  const header = ['id', 'name'];
  const rows = Array.from({ length: 300 }, (_, i) => [`c${i}`, `row-${i}`]);
  writeCollection('big', header, rows);
  const r = await tools.collectionsSearch({ name: 'big', limit: 100000 });
  assert.equal(r.rows.length, 200, 'limit 夹到 MAX_LIMIT=200');
  assert.equal(r.truncated, true);
  assert.equal(r.next_offset, 200);
});

test('M4.7 字节预算：rows 序列化超预算从尾部裁行并标 truncated（next_offset 反映实裁行数）', async () => {
  const header = ['id', 'a', 'b', 'c', 'd', 'e'];
  const fat = 'x'.repeat(400); // 每字段 400 字符（= MAX_FIELD 满格）→ 每行约 2KB
  const rows = Array.from({ length: 40 }, (_, i) => [`c${i}`, fat, fat, fat, fat, fat]);
  writeCollection('fat', header, rows);

  const r = await tools.collectionsSearch({ name: 'fat' }); // 默认 limit=50 > 40，故必由字节预算裁
  assert.ok(r.rows.length >= 1 && r.rows.length < 40, '被字节预算从尾部裁掉一部分行');
  assert.equal(r.truncated, true);
  assert.equal(r.returned, r.rows.length);
  assert.equal(r.next_offset, r.rows.length, 'offset=0 时 next_offset=实返行数');
  // 如实标注：序列化后的 rows 确在预算内（40KB）
  assert.ok(Buffer.byteLength(JSON.stringify(r.rows)) <= 40 * 1024);
});

test('M4.2 search 分层：默认只返 canonical；include=candidate 现候选页；rejected 隔离件仅高信任+include 可见', async () => {
  const kDir = path.join(instanceDir, 'knowledge');
  writeFileSync(path.join(kDir, 'tier-cand.md'),
    '---\ntier: candidate\ntitle: 候选\ntype: knowledge\n---\n\n分层词 stierprobe 出现在候选页。\n');
  writeFileSync(path.join(kDir, 'tier-canon.md'),
    '---\ntier: canonical\ntitle: 正典\ntype: knowledge\n---\n\n分层词 stierprobe 出现在正典页。\n');
  const inboxDir = path.join(instanceDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(path.join(inboxDir, '_2026-07-05-rej.md'),
    '---\nid: rj\ntype: inbox\ntier: rejected\nstatus: rejected\n---\n\n分层词 stierprobe 出现在隔离件。\n');

  const P = (r) => r.results.map((x) => x.path);
  // 默认（high）：只见 canonical 页；不见 candidate、不见 rejected 隔离件
  const def = await tools.search({ query: 'stierprobe', trust: 'high' });
  assert.ok(P(def).includes('knowledge/tier-canon.md'));
  assert.ok(!P(def).includes('knowledge/tier-cand.md'), '默认不含 candidate');
  assert.ok(!P(def).some((p) => p.startsWith('inbox/')), '默认不含 rejected 隔离件');
  assert.ok(def.results.every((r) => r.tier === 'canonical'), '结果带 tier 字段');
  // include=candidate：候选页现
  const incC = await tools.search({ query: 'stierprobe', trust: 'high', include: 'candidate' });
  assert.ok(P(incC).includes('knowledge/tier-cand.md'), 'include=candidate 现候选页');
  // include=rejected 高信任：隔离件现
  const incR = await tools.search({ query: 'stierprobe', trust: 'high', include: 'rejected' });
  assert.ok(P(incR).some((p) => p.startsWith('inbox/')), 'include=rejected 高信任可见隔离件');
  // 低信任 include=rejected：隔离件不可见（未注册 zone 仅 high）
  const lowR = await tools.search({ query: 'stierprobe', trust: 'low', include: 'rejected' });
  assert.ok(!P(lowR).some((p) => p.startsWith('inbox/')), '低信任仍不得见隔离件');
});

test('Skill _incoming 明确为 staging：默认不冒充 canonical，仅 high+include=staging 可见', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-tools-staging-'));
  cpSync(fixtureDir, dir, { recursive: true });
  const zonesPath = path.join(dir, 'governance', 'zones.md');
  writeFileSync(zonesPath, readFileSync(zonesPath, 'utf8').replace('zones:\n', [
    'zones:', '  - id: skills', '    path: skills/', '    purpose: Skill 目录',
    '    privacy: private', '',
  ].join('\n')));
  const incoming = path.join(dir, 'skills', '_incoming', 'staging-search');
  mkdirSync(incoming, { recursive: true });
  writeFileSync(path.join(incoming, 'SKILL.md'), '---\nname: staging-search\n---\n\nstagingprobe 未晋升内容。\n');
  const scoped = createTools({ instanceDir: dir });
  assert.equal((await scoped.search({ query: 'stagingprobe', trust: 'high' })).results.length, 0, 'high 默认档也不得当 canonical 返回');
  const high = await scoped.search({ query: 'stagingprobe', trust: 'high', include: 'staging' });
  assert.equal(high.results.length, 1);
  assert.equal(high.results[0].tier, 'staging');
  assert.equal((await scoped.search({ query: 'stagingprobe', trust: 'low', include: 'staging' })).results.length, 0, '低信任不能请求 staging');
});
