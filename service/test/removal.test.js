import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInbox, createAdmission } from '../src/inbox.js';
import { createWriter } from '../src/writer.js';
import { createKeeper } from '../src/keeper.js';
import { validateDecisionPlan } from '../src/executor.js';
import { encodeRemovalRequest, readRemovalRequest, removalDecision } from '../src/removal.js';
import { testAdmissionForKind } from './helpers/admission.js';
import { encodeTodoRequest } from '../src/todo.js';

const fixture = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function setup({ prepare, judge } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-removal-'));
  const work = path.join(base, 'work'), origin = path.join(base, 'origin.git');
  git(base, 'init', '--bare', '-b', 'main', origin);
  cpSync(fixture, work, { recursive: true });
  prepare?.(work);
  git(work, 'init', '-b', 'main'); git(work, 'add', '.'); git(work, 'commit', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin); git(work, 'push', '-u', 'origin', 'main');
  const writer = createWriter({ instanceDir: work }), nativeReg = new Map(), approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, approvals, admissionProvider: testAdmissionForKind });
  const calls = [], notifications = [];
  const keeper = createKeeper({ instanceDir: work, writer, nativeReg, approvals,
    provider: { judge: async req => { calls.push(req); if (judge) return judge(req); throw new Error('explicit removal must not use a model'); } },
    notifier: { notify: async text => { notifications.push(text); return { ok: true }; } },
  });
  const submit = async (kind, value, raw = false) => {
    const receipt = inbox.addEntry({ kind, content: raw ? value : encodeRemovalRequest(kind, value), client: 'test' });
    await receipt.synced;
    return { receipt, result: await keeper.processPending() };
  };
  return { work, origin, inbox, keeper, calls, notifications, submit };
}

test('explicit page deletion and legacy literal path use code, preserve neighbours and retry safely', async () => {
  for (const raw of [false, true]) {
    const f = setup();
    const request = raw ? 'knowledge/coffee-brewing.md（已迁到共享库）' : { path: 'knowledge/coffee-brewing.md', reason: '已迁到共享库' };
    const todoBefore = readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8');
    assert.equal((await f.submit('remove', request, raw)).result.filed, 1);
    assert.ok(!existsSync(path.join(f.work, 'knowledge/coffee-brewing.md')));
    assert.equal((await f.submit('remove', request, raw)).result.filed, 1);
    assert.match(f.notifications.at(-1), /未作修改/);
    assert.ok(!f.notifications.at(-1).includes('✅ 已删'));
    assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), todoBefore);
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.work, 'status', '--porcelain').trim(), '');
    assert.equal(git(f.work, 'rev-parse', 'HEAD'), git(f.origin, 'rev-parse', 'main'));
  }
});

test('remove a completed task and its notes without completing or altering any other task', async () => {
  const text = '## 待办\n1. 重复任务\n2. 保留事项\n\n## 已完成\n- 重复任务 ✅ 2025-01-02\n\n  > 备注（2025-01-02）：\n  > 已迁移\n\n- 保留完成项 ✅ 2025-02-01\n';
  const f = setup({ prepare: w => writeFileSync(path.join(w, 'todo/owner.md'), text) });
  const item = '- 重复任务 ✅ 2025-01-02';
  assert.equal((await f.submit('todo_remove', { item })).result.filed, 1);
  const after = readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8');
  assert.ok(!after.includes('已迁移') && !after.includes('2025-01-02'));
  assert.ok(after.includes('1. 重复任务\n2. 保留事项'));
  assert.ok(after.includes('- 保留完成项 ✅ 2025-02-01'));
  assert.equal((await f.submit('todo_remove', { item })).result.filed, 1);
  assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), after);
  assert.equal(f.calls.length, 0);
});

test('ambiguous task removals hold unchanged and offer authenticated discard; partial titles are honest no-ops', async () => {
  const f = setup({ prepare: w => writeFileSync(path.join(w, 'todo/owner.md'), '## 待办\n1. 重复任务\n2. 重复任务\n3. 唯一事项\n') });
  const before = readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8');
  for (const item of ['重复任务']) {
    const { receipt, result } = await f.submit('todo_remove', { item });
    assert.equal(result.held, 1);
    assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), before);
    await f.inbox.resolveEntry({ id: receipt.id, option: 0, viaTrust: 'high', via: 'test' }).synced;
    assert.equal((await f.keeper.processPending()).rejected, 1);
  }
  assert.equal((await f.submit('todo_remove', { item: '唯一' })).result.filed, 1);
  assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), before);
  assert.match(f.notifications.at(-1), /未作修改/);
  assert.ok(!f.notifications.at(-1).includes('已移除指定待办'));
  assert.equal(f.calls.length, 0);
});

test('copied numbered task line selects the open duplicate and retries do not fall through to history or prefixes', async () => {
  const f = setup({ prepare: w => writeFileSync(path.join(w, 'todo/owner.md'), '## 待办\n1. 买牛奶\n2. 买牛奶和面包\n\n## 已完成\n- 买牛奶 ✅ 2025-01-02\n') });
  assert.equal((await f.submit('todo_remove', { item: '1. 买牛奶' })).result.filed, 1);
  const after = readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8');
  assert.ok(after.includes('2. 买牛奶和面包') && after.includes('- 买牛奶 ✅ 2025-01-02'));
  assert.equal((await f.submit('todo_remove', { item: '1. 买牛奶' })).result.filed, 1);
  assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), after);
  const g = setup({ prepare: w => writeFileSync(path.join(w, 'todo/owner.md'), '## 待办\n1. 买牛奶\n2. 买牛奶和面包\n') });
  assert.equal((await g.submit('todo_remove', { item: '买牛奶' })).result.filed, 1);
  assert.equal((await g.submit('todo_remove', { item: '买牛奶' })).result.filed, 1);
  assert.match(readFileSync(path.join(g.work, 'todo/owner.md'), 'utf8'), /2\. 买牛奶和面包/);
});

test('collection removal commits exact rows and derived counts atomically and is idempotent', async () => {
  const f = setup({ prepare: w => writeFileSync(path.join(w, 'collections/restaurants/README.md'), '# 餐厅\n共 **2** 条\n') });
  const original = readFileSync(path.join(f.work, 'collections/restaurants/data.csv'), 'utf8');
  const value = { collection: 'restaurants', ids: ['demo-ramen', 'missing-id'] };
  assert.equal((await f.submit('collection_remove', value)).result.filed, 1);
  const after = readFileSync(path.join(f.work, 'collections/restaurants/data.csv'), 'utf8');
  assert.equal(after, original.split('\n').filter(l => !l.startsWith('demo-ramen,')).join('\n'));
  assert.match(readFileSync(path.join(f.work, 'collections/restaurants/README.md'), 'utf8'), /\*\*1\*\*/);
  assert.equal((await f.submit('collection_remove', value)).result.filed, 1);
  assert.equal(readFileSync(path.join(f.work, 'collections/restaurants/data.csv'), 'utf8'), after);
  assert.equal(f.calls.length, 0);
});

test('doctor failure rolls back every removal kind and retains a retryable receipt', async () => {
  for (const [kind, value, rel] of [
    ['remove', { path: 'knowledge/coffee-brewing.md' }, 'knowledge/coffee-brewing.md'],
    ['todo_remove', { item: '给自行车换轮胎' }, 'todo/owner.md'],
    ['collection_remove', { collection: 'restaurants', ids: ['demo-ramen'] }, 'collections/restaurants/data.csv'],
  ]) {
    const f = setup({ prepare: w => writeFileSync(path.join(w, 'skills/substrate-doctor/doctor.py'), 'print("→ 1 error(s)")\n') });
    const before = readFileSync(path.join(f.work, rel), 'utf8');
    const { result, receipt } = await f.submit(kind, value);
    assert.equal(result.held, 1);
    assert.equal(readFileSync(path.join(f.work, rel), 'utf8'), before);
    assert.match(readFileSync(path.join(f.work, receipt.path), 'utf8'), /doctor 报 1 error/);
    assert.equal(git(f.work, 'status', '--porcelain').trim(), '');
  }
});

test('native proof binds removal targets and rejects post-submission tampering before any model', async () => {
  for (const [kind, value, from, to] of [
    ['remove', { path: 'knowledge/coffee-brewing.md' }, 'coffee-brewing', 'other-page'],
    ['todo_remove', { item: '给自行车换轮胎' }, '给自行车换轮胎', '读完《测试驱动开发》'],
    ['collection_remove', { collection: 'restaurants', ids: ['demo-ramen'] }, 'demo-ramen', 'demo-sichuan'],
  ]) {
    const f = setup();
    const receipt = f.inbox.addEntry({ kind, content: encodeRemovalRequest(kind, value), client: 'test' });
    await receipt.synced;
    const p = path.join(f.work, receipt.path);
    writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
    git(f.work, 'add', '.'); git(f.work, 'commit', '-m', 'tamper'); git(f.work, 'push');
    assert.equal((await f.keeper.processPending()).held, 1);
    assert.match(readFileSync(p, 'utf8'), /held_class: security/);
    assert.equal(f.calls.length, 0);
  }
});

test('dedicated capabilities and exact target binding reject retargeting, generic save and capture', () => {
  const f = setup();
  for (const [kind, value, cap] of [
    ['remove', { path: 'knowledge/coffee-brewing.md' }, 'page:remove'],
    ['todo_remove', { item: '给自行车换轮胎' }, 'todo:remove'],
    ['collection_remove', { collection: 'restaurants', ids: ['demo-ramen'] }, 'collection:remove'],
  ]) {
    const entry = { kind, body: encodeRemovalRequest(kind, value), __native: true, __capabilities: [cap] };
    const decision = removalDecision(f.work, entry, readRemovalRequest(entry));
    assert.equal(validateDecisionPlan({ instanceDir: f.work, entry, decision }).ok, true);
    assert.equal(validateDecisionPlan({ instanceDir: f.work, entry: { ...entry, __ruling_authentic: true, __ruling_trust: 'capture' }, decision }).ok, false);
    for (const d of [{ ...decision, target: 'other' }, { ...decision, action: 'remove_page', zone: 'knowledge', target: 'other' }]) {
      assert.equal(validateDecisionPlan({ instanceDir: f.work, entry, decision: d }).ok, false);
    }
    for (const ingress of ['save', 'capture', 'todo_done', 'collections_upsert']) {
      const caps = createAdmission({ identity: { trust: 'high' }, ingress }).capabilities;
      assert.ok(!caps.includes(cap));
      assert.equal(validateDecisionPlan({ instanceDir: f.work, entry: { ...entry, __capabilities: caps }, decision }).ok, false);
    }
  }
});

test('page removals cannot target structures, typed zones, symlinks or traversal', async () => {
  const f = setup({ prepare: w => {
    writeFileSync(path.join(w, 'knowledge/README.md'), '# Knowledge\n');
    mkdirSync(path.join(w, 'knowledge/nested'));
    symlinkSync(path.join(w, 'knowledge/coffee-brewing.md'), path.join(w, 'knowledge/link.md'));
    symlinkSync(path.join(w, 'knowledge/nested'), path.join(w, 'knowledge/linkdir'));
  } });
  for (const target of ['todo/owner.md', 'collections/restaurants/README.md', 'knowledge/README.md', 'knowledge/readme.md', 'knowledge/Coffee-brewing.md', 'memory/about-owner/_core.md', 'governance/zones.md', 'knowledge/link.md', 'knowledge/linkdir/absent.md']) {
    assert.equal((await f.submit('remove', { path: target })).result.held, 1, target);
  }
  assert.throws(() => encodeRemovalRequest('remove', { path: 'knowledge/../todo/owner.md' }));
  assert.throws(() => encodeRemovalRequest('remove', { path: '/tmp/file.md' }));
  assert.throws(() => encodeRemovalRequest('remove', { path: 'knowledge/.git/internal.md' }));
  assert.ok(existsSync(path.join(f.work, 'knowledge/coffee-brewing.md')));
  assert.ok(existsSync(path.join(f.work, 'knowledge/README.md')));
  assert.equal(f.calls.length, 0);
});

test('legacy natural-language removal receives removable inventory despite no append permission', async () => {
  const f = setup({ prepare: w => {
    symlinkSync(path.join(w, 'knowledge'), path.join(w, 'knowledge/loop'));
    symlinkSync(path.join(w, 'todo/owner.md'), path.join(w, 'knowledge/linked.md'));
  }, judge: req => {
    assert.match(req.user, /可删页面路径[^]*knowledge\/coffee-brewing.md/);
    assert.match(req.user, /"page_append_zones":\[\]/);
    assert.ok(!req.user.includes('knowledge/loop/') && !req.user.includes('knowledge/linked.md'));
    return { json: { disposition: 'canonical', zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing', confidence: 1, summary: '删除明确指定的咖啡页' } };
  } });
  assert.equal((await f.submit('remove', '请删除咖啡冲煮那页', true)).result.filed, 1);
});

test('an existing signed completion request explicitly saying not completed is held without changing state', async () => {
  const f = setup();
  const before = readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8');
  const body = '```json\n' + JSON.stringify({ todo_request: 1, item: '给自行车换轮胎', note: '不是已完成：仅迁移出当前清单' }) + '\n```';
  assert.equal((await f.submit('todo_done', body, true)).result.held, 1);
  assert.equal(readFileSync(path.join(f.work, 'todo/owner.md'), 'utf8'), before);
  assert.equal(f.calls.length, 0);
});

test('leading explicit non-completion phrasings are rejected, without interpreting the rest of the note', () => {
  for (const note of ['不要标记为完成', '不要标记为已完成', '未完成（迁到共享库）', '不是已经完成', '没有完成', '还没完成', '并非完成', 'Not complete: moved', 'do not mark as done']) {
    assert.throws(() => encodeTodoRequest({ item: '任务', note }, 'todo_done'), /不能调用 todo_done/);
  }
  for (const note of ['未完成的部分已交给同事', '已完成，未完成项另记', '已完成', '完成：已迁移']) {
    assert.doesNotThrow(() => encodeTodoRequest({ item: '任务', note }, 'todo_done'));
  }
});
