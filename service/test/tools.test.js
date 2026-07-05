import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../src/tools.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
let instanceDir;
let tools;

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
