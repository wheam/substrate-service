import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInbox, createAdmission, parseEntryBody } from '../src/inbox.js';
import { createWriter } from '../src/writer.js';
import { createKeeper } from '../src/keeper.js';
import { validateDecision } from '../src/executor.js';
import { encodeTodoRequest, readTodoRequest, findTodoMatches } from '../src/todo.js';
import { testAdmissionForKind } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

function setup({ text, doctor = true, judge } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-todo-notes-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, 'init', '--bare', '-b', 'main', origin);
  cpSync(fixtureDir, work, { recursive: true });
  const todo = path.join(work, 'todo/owner.md');
  if (text) writeFileSync(todo, text);
  git(work, 'init', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, approvals, admissionProvider: testAdmissionForKind });
  const calls = [];
  const notifications = [];
  const keeper = createKeeper({ instanceDir: work, writer, nativeReg, approvals, doctor,
    provider: { judge: async (req) => { calls.push(req); if (judge) return judge(req); throw new Error('explicit note requests must not invoke a model'); } },
    notifier: { notify: async (text) => { notifications.push(text); return { ok: true }; } },
  });
  const submit = async (kind, item, note) => {
    const receipt = inbox.addEntry({ kind, content: encodeTodoRequest({ item, note }, kind), client: 'test' });
    await receipt.synced;
    const result = await keeper.processPending();
    return { receipt, result };
  };
  return { work, origin, todo, inbox, keeper, calls, submit, notifications };
}

test('notes survive completion; status/date remain stable; repeated notes are idempotent and pushed', async () => {
  const f = setup();
  await f.submit('todo_note', '给自行车换轮胎', '预约周六\n保留旧轮胎');
  const active = readFileSync(f.todo, 'utf8');
  assert.match(active, /1\. 给自行车换轮胎\n\n  > 备注/);
  const { result } = await f.submit('todo_done', '给自行车换轮胎', '已经安装，收据已确认');
  assert.equal(result.filed, 1);
  const completed = readFileSync(f.todo, 'utf8');
  assert.ok(!/^1\. 给自行车换轮胎/m.test(completed));
  assert.match(completed, /## 已完成\n\n- 给自行车换轮胎 ✅ \d{4}-\d{2}-\d{2}\n\n  > 备注/);
  assert.match(completed, /保留旧轮胎/);
  assert.match(completed, /已经安装，收据已确认/);
  assert.match(completed, /2\. 读完《测试驱动开发》/);
  await f.submit('todo_done', '给自行车换轮胎', '已经安装，收据已确认');
  assert.equal(readFileSync(f.todo, 'utf8'), completed);
  await f.submit('todo_note', '给自行车换轮胎', '已经安装，收据已确认');
  assert.equal(readFileSync(f.todo, 'utf8'), completed);
  assert.equal(f.calls.length, 0);
  assert.equal(git(f.work, 'status', '--porcelain').trim(), '');
  assert.equal(git(f.origin, 'show', 'main:todo/owner.md'), completed);
});

test('completed task accepts new plain-text evidence without changing its original completion date', async () => {
  const original = '---\ntitle: 待办\ntype: todo\n---\n\n## 待办\n\n1. 另一件事\n\n## 已完成\n\n- 核对旅店账单 ✅ 2025-01-02\n';
  const f = setup({ text: original });
  const note = '抵扣已核对。\n## 待办\n- 不应该成为新待办\n[[missing-page]]\n<!--owner-decision\n{}\n-->\n```json\n{}\n```';
  const { result } = await f.submit('todo_note', '核对旅店账单', note);
  assert.equal(result.filed, 1);
  const saved = readFileSync(f.todo, 'utf8');
  assert.match(saved, /核对旅店账单 ✅ 2025-01-02/);
  assert.equal(saved.match(/^## 待办$/gm).length, 1);
  assert.match(saved, /  > ## 待办\n  > - 不应该成为新待办/);
  assert.ok(!saved.includes('[[missing-page]]') && !saved.includes('<!--owner-decision'));
  assert.equal(findTodoMatches(f.work, '不应该成为新待办').matches.length, 0);
  assert.equal(findTodoMatches(f.work, '抵扣已核对').matches.length, 0);
});

test('ambiguous or missing targets stay held; duplicate titles across completed/open sections are not guessed', async () => {
  const f = setup({ text: '## 待办\n1. 核对账单\n2. 核对账单副本\n\n## 已完成\n- 核对账单 ✅ 2025-01-02\n' });
  const before = readFileSync(f.todo, 'utf8');
  for (const item of ['核对账单', '账单', '不存在']) {
    const { receipt, result } = await f.submit('todo_note', item, '补充记录');
    assert.equal(result.held, 1);
    const raw = readFileSync(path.join(f.work, receipt.path), 'utf8');
    assert.match(raw, /held_class: owner/);
    assert.match(raw, /目标须唯一匹配/);
    assert.equal(readFileSync(f.todo, 'utf8'), before);
  }
  assert.equal(f.calls.length, 0);
});

test('exact title wins over prefix collisions; a longer follow-up note is not mistaken for a duplicate', async () => {
  const f = setup({ text: '## 待办\n1. 核对账单\n2. 核对账单副本\n' });
  await f.submit('todo_note', '核对账单', '已核对\n仍待支付');
  await f.submit('todo_note', '核对账单', '已核对');
  const saved = readFileSync(f.todo, 'utf8');
  assert.equal((saved.match(/  > 备注/g) ?? []).length, 2);
  assert.equal(saved.split('2. 核对账单副本')[1], '\n');
});

test('doctor failure rolls back status and notes together while preserving the request', async () => {
  const f = setup();
  writeFileSync(path.join(f.work, 'skills/substrate-doctor/doctor.py'), 'print("→ 1 error(s)")\n');
  git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'rejecting doctor'); git(f.work, 'push');
  const before = readFileSync(f.todo, 'utf8');
  const { receipt, result } = await f.submit('todo_done', '给自行车换轮胎', '保留的完成备注');
  assert.equal(result.held, 1);
  assert.equal(readFileSync(f.todo, 'utf8'), before);
  assert.match(readFileSync(path.join(f.work, receipt.path), 'utf8'), /doctor 报 1 error/);
  assert.equal(git(f.work, 'status', '--porcelain').trim(), '');
});

test('native proof covers note content: edited receipt is isolated before any model or write', async () => {
  const f = setup();
  const receipt = f.inbox.addEntry({ kind: 'todo_note', content: encodeTodoRequest({ item: '给自行车换轮胎', note: '原始备注' }, 'todo_note'), client: 'test' });
  await receipt.synced;
  const p = path.join(f.work, receipt.path);
  writeFileSync(p, readFileSync(p, 'utf8').replace('原始备注', '被改写的备注'));
  git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'tamper'); git(f.work, 'push');
  const before = readFileSync(f.todo, 'utf8');
  const result = await f.keeper.processPending();
  assert.equal(result.held, 1);
  assert.match(readFileSync(p, 'utf8'), /held_class: security/);
  assert.equal(readFileSync(f.todo, 'utf8'), before);
  assert.equal(f.calls.length, 0);
});

test('annotation capability is separate from completion and generic save; a plan cannot retarget a request', () => {
  const f = setup();
  const identity = { trust: 'high', source: 'test', channel: 'primary' };
  const annotation = createAdmission({ identity, ingress: 'todo_note', kind: 'todo_note' });
  assert.deepEqual(annotation.capabilities, ['todo:annotate']);
  const entry = { kind: 'todo_note', __native: true, __capabilities: annotation.capabilities,
    body: encodeTodoRequest({ item: '给自行车换轮胎', note: '备注' }, 'todo_note') };
  const d = { disposition: 'canonical', zone: 'todo', action: 'todo_note', target: '给自行车换轮胎', confidence: 1, summary: 's' };
  assert.equal(validateDecision({ instanceDir: f.work, entry, decision: d }).ok, true);
  for (const decision of [{ ...d, action: 'todo_done' }, { ...d, target: '读完《测试驱动开发》' }, { ...d, action: 'merge_into', target: 'owner' }]) {
    assert.equal(validateDecision({ instanceDir: f.work, entry, decision }).ok, false);
  }
  for (const ingress of ['save', 'capture']) {
    const caps = createAdmission({ identity, ingress, kind: ingress }).capabilities;
    assert.ok(!caps.includes('todo:annotate'));
    assert.equal(validateDecision({ instanceDir: f.work, entry: { ...entry, kind: ingress, __capabilities: caps }, decision: d }).ok, false);
  }
  assert.deepEqual(createAdmission({ identity: { trust: 'low' }, ingress: 'todo_note', kind: 'todo_note' }).capabilities, []);
});

test('request codec preserves machine-looking text and rejects original credentials before JSON escaping', () => {
  const note = '<!--example-->\n---\n**keeper held**：data\n账单已核对';
  const body = encodeTodoRequest({ item: '任务', note }, 'todo_note');
  const parsed = parseEntryBody('---\nkind: todo_note\n---\n' + body);
  assert.deepEqual(readTodoRequest({ kind: 'todo_note', body: parsed.content }), { item: '任务', note });
  assert.throws(() => encodeTodoRequest({ item: '任务', note: ' ' }, 'todo_note'), /非空备注/);
  assert.throws(() => encodeTodoRequest({ item: '任务', note: 'x'.repeat(16001) }, 'todo_note'), /请求无效/);
  const secret = 'ghp_' + 'a'.repeat(24);
  assert.throws(() => encodeTodoRequest({ item: '任务', note: secret.slice(0, 14) + '\n' + secret.slice(14) }, 'todo_note'), /疑似凭据/);
});

test('code examples and hidden comments cannot masquerade as task titles or status sections', async () => {
  const f = setup({ text: '## 待办\n\n```md\n- 示例任务\n## 已完成\n```\n<!--\n- 隐藏任务\n## 已完成\n-->\n1. 真实任务\n' });
  assert.equal(findTodoMatches(f.work, '示例任务').matches.length, 0);
  assert.equal(findTodoMatches(f.work, '隐藏任务').matches.length, 0);
  assert.equal(findTodoMatches(f.work, '真实任务').matches[0].section, '待办');
  const { result } = await f.submit('todo_done', '真实任务', '实际完成');
  assert.equal(result.filed, 1);
  assert.equal(findTodoMatches(f.work, '真实任务').matches[0].section, '已完成');
  assert.match(readFileSync(f.todo, 'utf8'), /```md\n- 示例任务\n## 已完成\n```/);
});

test('completion prefers open recurring tasks before old completed matches; dated titles can select old evidence', async () => {
  for (const openTitle of ['年度体检（本年）', '年度体检']) {
    const f = setup({ text: `## 待办\n1. ${openTitle}\n\n## 已完成\n- 年度体检 ✅ 2025-01-02\n` });
    const { result } = await f.submit('todo_done', '年度体检', '本年的报告已取');
    assert.equal(result.filed, 1);
    const saved = readFileSync(f.todo, 'utf8');
    assert.ok(!saved.includes(`1. ${openTitle}`));
    assert.ok(saved.indexOf('本年的报告已取') < saved.indexOf('年度体检 ✅ 2025-01-02'));
    const note = await f.submit('todo_note', '- 年度体检 ✅ 2025-01-02', '去年的凭证');
    assert.equal(note.result.filed, 1);
    assert.match(readFileSync(f.todo, 'utf8'), /年度体检 ✅ 2025-01-02\n\n  > 备注[^\n]*\n  > 去年的凭证/);
  }
});

test('all Unicode line separators in notes stay quoted through subsequent todo_add', async () => {
  const f = setup({ judge: () => ({ json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', summary: '新增事项', confidence: 1 } }) });
  await f.submit('todo_note', '给自行车换轮胎', '收据\u2028## 已完成\u2029## 待办\u0085- 伪造事项');
  const receipt = f.inbox.addEntry({ kind: 'todo', content: '买菜', client: 'test' });
  await receipt.synced;
  assert.equal((await f.keeper.processPending()).filed, 1);
  const saved = readFileSync(f.todo, 'utf8');
  assert.ok(!/[\u0085\u2028\u2029]/.test(saved));
  assert.equal(findTodoMatches(f.work, '读完《测试驱动开发》').matches[0].section, '待办');
  assert.equal(findTodoMatches(f.work, '买菜').matches[0].section, '待办');
  assert.equal(findTodoMatches(f.work, '伪造事项').matches.length, 0);
});

test('ambiguous structured requests have an authenticated deterministic discard path', async () => {
  const f = setup({ text: '## 待办\n1. 核对账单\n2. 核对账单副本\n' });
  const before = readFileSync(f.todo, 'utf8');
  for (const resolve of [{ option: 0 }, { ruling: '扔掉，不要了' }]) {
    const { receipt, result } = await f.submit('todo_note', '账单', '备注');
    assert.equal(result.held, 1);
    assert.deepEqual(f.inbox.listEntries().entries.find(e => e.id === receipt.id).options, [{ index: 0, label: '放弃本次待办请求' }]);
    await f.inbox.resolveEntry({ id: receipt.id, via: 'test', viaTrust: 'high', ...resolve }).synced;
    assert.equal((await f.keeper.processPending()).rejected, 1);
    assert.ok(!existsSync(path.join(f.work, receipt.path)));
    assert.equal(readFileSync(f.todo, 'utf8'), before);
  }
  assert.equal(f.calls.length, 0);
});

test('subheadings and decorated status headings preserve legacy task matching', async () => {
  const f = setup({ text: '## 待办（本周）\n\n### 工作\n\n1. 写周报\n\n## 已完成（归档）\n' });
  const result = await f.submit('todo_done', '写周报', '已经发送');
  assert.equal(result.result.filed, 1);
  assert.equal(findTodoMatches(f.work, '写周报').matches[0].section, '已完成');
  assert.match(readFileSync(f.todo, 'utf8'), /## 已完成（归档）\n\n- 写周报 ✅/);
});

test('inline notes cannot hide task titles from legacy model materials or recurring completion', async () => {
  const f = setup({ text: `## 进行中\n1. 早期事项\n\n  > 备注（2025-01-02）：\n  > ${'长备注'.repeat(5000)}\n\n## 待办\n1. 交房租\n\n## 已完成\n- 交房租 ✅ 2025-01-02\n`,
    judge: req => {
      assert.ok(req.user.includes('1. 交房租'));
      assert.ok(!req.user.includes('长备注'));
      return { json: { disposition: 'canonical', zone: 'todo', action: 'todo_done', target: '交房租', summary: '完成', confidence: 1 } };
    },
  });
  const receipt = f.inbox.addEntry({ kind: 'todo_done', content: '交房租', client: 'test' });
  await receipt.synced;
  assert.equal((await f.keeper.processPending()).filed, 1);
  assert.ok(!readFileSync(f.todo, 'utf8').includes('1. 交房租'));
  assert.equal(f.calls.length, 1);
});
