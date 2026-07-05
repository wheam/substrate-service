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

test('缺陷1附带：低信任 search 不得命中未注册 zone（inbox 隔离件）；高信任仍可见', async () => {
  const inboxDir = path.join(instanceDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(path.join(inboxDir, '_2026-07-05-q.md'),
    '---\nstatus: pending\n---\n\n隔离件 searchquarantine 龙虾待判。\n');
  const low = await tools.search({ query: 'searchquarantine', trust: 'low' });
  assert.equal(low.results.length, 0, '低信任不得 search 到 inbox 隔离件（未注册 zone 收紧为仅 high 可读）');
  const high = await tools.search({ query: 'searchquarantine', trust: 'high' });
  assert.ok(high.results.some((r) => r.path.startsWith('inbox/')), '高信任仍可见');
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
