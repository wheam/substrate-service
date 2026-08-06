// M4.4 溯源/置信/epistemic_type frontmatter（spec §3.3 / §6.1）。
// 为什么直调 validateDecision + applyDecision（不经 keeper/LLM）：溯源落盘是确定性执行器的职责，
//   与模型判断无关；直调把「校验归一 → 落盘」这段单独钉死，跑得快、断言精确。生产同序（keeper 先校验后执行）。
// 三条不变量：
//   1) new_page 把「谁提的 / 多有把握 / 什么认知类型」落进页级 frontmatter（source_agent/confidence/epistemic_type）。
//   2) merge_into 不动页级 frontmatter（一页可混多种认知类型，不在页头钉死单一来源/类型）——改由归档注记行携带。
//   3) epistemic_type 是容错元数据：白名单外/缺省一律归一 null，绝不因此拒件（假 provider/旧金标无此字段仍须照常入库）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDecision, applyDecision } from '../src/executor.js';
import { testAuthorizedEntry } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
function tmpInstance(tag) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`)), 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

// 生产同序：先 validateDecision（就地归一 epistemic_type/tier），再 applyDecision 落盘。
function fileIt(dir, decision, entry) {
  const v = validateDecision({ instanceDir: dir, decision, entry: testAuthorizedEntry(entry) });
  assert.ok(v.ok, `本用例前置：decision 应校验通过（实际 reason=${v.reason ?? ''}）`);
  return applyDecision({ instanceDir: dir, entry, decision, zone: v.zone });
}

test('new_page：溯源三字段落 frontmatter，紧接 content_id/tier 之后', async () => {
  const dir = tmpInstance('prov-newpage');
  const entry = { id: 'inbox-e1', client: 'cc-test', body: '意式浓缩 92 度 9bar 萃取 25-30 秒。' };
  const decision = {
    disposition: 'canonical', zone: 'knowledge', action: 'new_page',
    target: 'espresso-basics', title: '意式浓缩要点', epistemic_type: 'fact',
    summary: '意式浓缩参数', confidence: 0.93,
  };
  await fileIt(dir, decision, entry);
  const raw = readFileSync(path.join(dir, 'knowledge', 'espresso-basics.md'), 'utf8');
  assert.match(raw, /^source_agent: cc-test$/m, 'source_agent = 件的 client（谁提的）');
  assert.match(raw, /^confidence: 0\.93$/m, 'confidence = 决定置信（多有把握）');
  assert.match(raw, /^epistemic_type: fact$/m, '合法 epistemic_type 落页级');
  // 顺序钉死：content_id → tier → source_agent → confidence → epistemic_type
  assert.match(raw, /tier: canonical\nsource_agent: cc-test\nconfidence: 0\.93\nepistemic_type: fact\n/,
    '三字段紧接 content_id/tier 之后');
});

test('epistemic_type 非法值 → 归一 null、不拒件；落盘省略该行但溯源二字段照写', async () => {
  const dir = tmpInstance('prov-illegal');
  const decision = {
    disposition: 'canonical', zone: 'knowledge', action: 'new_page',
    target: 'note-x', title: 'x', epistemic_type: 'made-up-type',
    summary: 's', confidence: 0.9,
  };
  const v = validateDecision({ instanceDir: dir, decision, entry: testAuthorizedEntry() });
  assert.equal(v.ok, true, '非法 epistemic_type 绝不拒件（元数据容错）');
  assert.equal(decision.epistemic_type, null, '就地归一 null（审计里 decision = 落盘事实）');
  await applyDecision({ instanceDir: dir, entry: { id: 'e2', client: 'hermes', body: '一段正文。' }, decision, zone: v.zone });
  const raw = readFileSync(path.join(dir, 'knowledge', 'note-x.md'), 'utf8');
  assert.ok(!/^epistemic_type:/m.test(raw), 'null 认知类型不写 frontmatter 行');
  assert.match(raw, /^source_agent: hermes$/m, '溯源仍照写');
  assert.match(raw, /^confidence: 0\.9$/m);
});

test('epistemic_type 缺省 → 归一 null、不拒件（假 provider/旧金标无此字段照常入库）', () => {
  const dir = tmpInstance('prov-absent');
  const decision = {
    disposition: 'canonical', zone: 'knowledge', action: 'new_page',
    target: 'note-y', title: 'y', summary: 's', confidence: 0.9,
  };
  const v = validateDecision({ instanceDir: dir, decision, entry: testAuthorizedEntry() });
  assert.equal(v.ok, true, '缺 epistemic_type 字段照样过校验');
  assert.equal(decision.epistemic_type, null, '缺省归一 null');
});

test('merge_into：注记行带 confidence 与 type；页级 frontmatter 不新增溯源字段', async () => {
  const dir = tmpInstance('prov-merge');
  const target = path.join(dir, 'knowledge', 'coffee-brewing.md');
  const fmBefore = readFileSync(target, 'utf8').match(/^---\n[\s\S]*?\n---/)[0];
  const entry = { id: 'inbox-m1', client: 'app-ios', body: '手冲闷蒸 30 秒更均匀。' };
  const decision = {
    disposition: 'canonical', zone: 'knowledge', action: 'merge_into',
    target: 'coffee-brewing', epistemic_type: 'preference', summary: 's', confidence: 0.88,
  };
  await fileIt(dir, decision, entry);
  const raw = readFileSync(target, 'utf8');
  // 页级 frontmatter 原样——一页可混多种认知类型，不在页头钉死单一来源/类型
  assert.equal(raw.match(/^---\n[\s\S]*?\n---/)[0], fmBefore, 'merge_into 不动页级 frontmatter');
  assert.ok(!/^source_agent:/m.test(raw) && !/^epistemic_type:/m.test(raw), '页级不写溯源字段');
  // 归档注记行携带 confidence 与 type
  assert.match(raw, /（inbox inbox-m1，来自 app-ios，confidence 0\.88，type: preference）：/);
  assert.match(raw, /闷蒸 30 秒/, '正文照常并入');
});

test('merge_into：epistemic_type 缺省时注记行只带 confidence、不带 type', async () => {
  const dir = tmpInstance('prov-merge-notype');
  const entry = { id: 'm2', client: 'cc', body: '注水要匀。' };
  const decision = {
    disposition: 'canonical', zone: 'knowledge', action: 'merge_into',
    target: 'coffee-brewing', summary: 's', confidence: 0.9,
  };
  await fileIt(dir, decision, entry);
  const raw = readFileSync(path.join(dir, 'knowledge', 'coffee-brewing.md'), 'utf8');
  const noteLine = raw.match(/（inbox m2[^\n]*）：/)[0];
  assert.match(noteLine, /confidence 0\.9/, '注记行带 confidence');
  assert.ok(!noteLine.includes('type:'), '缺省 type 不进注记行');
});

test('todo_add / upsert_row 路径不受溯源改动影响（无 frontmatter 落点、不掺溯源字段）', async () => {
  const dir = tmpInstance('prov-todo-upsert');
  // todo_add：即便 decision 带 epistemic_type，也只按原样追加一行
  const todoDecision = {
    disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner',
    epistemic_type: 'decision', summary: '买猫粮', confidence: 0.97,
  };
  await fileIt(dir, todoDecision, { id: 't1', client: 'cc', body: '买猫粮' });
  const todo = readFileSync(path.join(dir, 'todo', 'owner.md'), 'utf8');
  assert.match(todo, /3\. 买猫粮/, 'fixture 已有 1、2 两条，新增为第 3 条');
  assert.ok(!/source_agent|epistemic_type/.test(todo), 'todo 清单不掺溯源字段');
  // upsert_row：CSV 无 frontmatter 落点，同样不受影响
  const colDecision = {
    disposition: 'canonical', zone: 'collections', action: 'upsert_row', target: 'restaurants',
    epistemic_type: 'excerpt', fields: { id: 'p1', name: '新店', city: '样例城' }, summary: 's', confidence: 0.9,
  };
  await fileIt(dir, colDecision, { id: 'c1', client: 'cc', body: '' });
  const csv = readFileSync(path.join(dir, 'collections', 'restaurants', 'data.csv'), 'utf8');
  assert.match(csv, /p1,新店,样例城/);
  assert.ok(!/source_agent|epistemic_type/.test(csv), 'CSV 不掺溯源字段');
});
