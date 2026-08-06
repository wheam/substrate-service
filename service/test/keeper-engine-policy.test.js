import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriter } from '../src/writer.js';
import { createAdmission, createInbox, nativeToken } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { applyDecisionPlan, validateDecisionPlan } from '../src/executor.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function fixtureCopy(prefix = 'policy') {
  const dir = mkdtempSync(path.join(tmpdir(), `substrate-${prefix}-`));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function gitInstance(prefix = 'policy') {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-${prefix}-`));
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
  return { origin, work };
}

const identity = (trust = 'high') => ({ trust, source: 'test', channel: 'primary' });
const admission = (trust, ingress, kind) => createAdmission({ identity: identity(trust), ingress, kind });
const decision = (overrides) => ({
  disposition: 'canonical', summary: 'policy test', confidence: 0.95, ...overrides,
});
const policyEntry = (a, kind) => ({
  id: 'policy-entry', kind, client: 'policy-test', body: '测试正文', admission: a,
  __native: true, __admission_enforced: true, __capabilities: [...a.capabilities],
});

test('AdmissionContext 权限矩阵：capture 仅新增，专用 ingress 与 high save 各守自己的 effect 边界', () => {
  const instanceDir = fixtureCopy('admission-matrix');
  const capture = admission('capture', 'capture', 'capture');
  const save = admission('high', 'save', 'save');
  const done = admission('high', 'todo_done', 'todo_done');
  const remove = admission('high', 'remove', 'remove');
  const unknown = admission('low', 'save', 'save');

  assert.deepEqual(capture.capabilities, ['collection:insert', 'page:create', 'todo:add']);
  assert.ok(save.capabilities.includes('page:create'));
  assert.ok(save.capabilities.includes('page:append'));
  assert.ok(save.capabilities.includes('target:explicit'));
  assert.ok(save.capabilities.includes('zone:sensitive-write'));
  assert.deepEqual(done.capabilities, ['todo:complete']);
  assert.deepEqual(remove.capabilities, ['page:remove']);
  assert.deepEqual(unknown.capabilities, []);

  const captureEntry = policyEntry(capture, 'capture');
  assert.equal(validateDecisionPlan({
    instanceDir, entry: captureEntry,
    decision: decision({ zone: 'knowledge', action: 'new_page', target: 'capture-new' }),
  }).ok, true, 'capture 可新建普通页');

  for (const denied of [
    decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' }),
    decision({ zone: 'memory', action: 'new_page', target: 'private-memory' }),
    decision({ zone: 'todo', action: 'todo_done', target: '给自行车换轮胎' }),
    decision({ zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing' }),
  ]) {
    const result = validateDecisionPlan({ instanceDir, entry: captureEntry, decision: denied });
    assert.equal(result.ok, false);
    assert.equal(result.holdClass, 'security');
  }

  const saveEntry = policyEntry(save, 'save');
  assert.equal(validateDecisionPlan({
    instanceDir, entry: saveEntry,
    decision: decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' }),
  }).ok, true, 'high save 可追加普通既有页');
  assert.equal(validateDecisionPlan({
    instanceDir, entry: saveEntry,
    decision: decision({ zone: 'memory', action: 'new_page', target: 'new-sensitive-memory' }),
  }).ok, true, 'high save 带 sensitive capability 时可新建敏感页');
  assert.equal(validateDecisionPlan({
    instanceDir, entry: saveEntry,
    decision: decision({ zone: 'todo', action: 'todo_add', target: 'owner' }),
  }).ok, true, 'high save 是通用新增入口，可让 LLM 路由到非覆盖型 todo_add');
  assert.equal(validateDecisionPlan({
    instanceDir, entry: saveEntry,
    decision: decision({ zone: 'todo', action: 'todo_done', target: '给自行车换轮胎' }),
  }).holdClass, 'security', '通用 save 仍不能完成/改写既有 typed 数据');

  assert.equal(validateDecisionPlan({
    instanceDir, entry: policyEntry(done, 'todo_done'),
    decision: decision({ zone: 'todo', action: 'todo_done', target: '给自行车换轮胎' }),
  }).ok, true, 'todo_done 专用 ingress 可完成唯一匹配项');
});

test('native proof 绑定 hint、AdmissionContext 与 received_at：任一篡改都会失效', async () => {
  const instanceDir = mkdtempSync(path.join(tmpdir(), 'substrate-proof-binding-'));
  mkdirSync(path.join(instanceDir, 'inbox'), { recursive: true });
  const nativeReg = new Map();
  const writer = { commitAndPush: async () => ({ ok: true }) };
  const a = admission('high', 'save', 'save');
  const inbox = createInbox({ instanceDir, writer, nativeReg });
  const receipt = inbox.addEntry({
    kind: 'save', content: '一条普通记录', hint: 'path: knowledge/original.md', client: 'policy-test', admission: a,
  });
  await receipt.synced;
  const raw = readFileSync(path.join(instanceDir, receipt.path), 'utf8');
  const registered = nativeReg.get(receipt.id);
  const prove = (candidate) => nativeToken({
    id: receipt.id, rel: receipt.path, kind: 'save', client: 'policy-test', raw: candidate,
  });

  assert.equal(prove(raw), registered);
  const mutations = {
    hint: raw.replace(/^hint: .*$/m, 'hint: path: knowledge/tampered.md'),
    admission: raw.replace(/^admission_capabilities: .*$/m, 'admission_capabilities: ["page:remove"]'),
    received_at: raw.replace(/^received_at: .*$/m, 'received_at: 2099-01-01T00:00:00.000Z'),
  };
  for (const [field, mutated] of Object.entries(mutations)) {
    assert.notEqual(prove(mutated), registered, `${field} 被改写后不得继续命中 native proof`);
  }
});

test('通用新页：high save 显式指向普通 zone 的不存在页面时直接创建，不进入 owner-held', async () => {
  const { work } = gitInstance('ordinary-create');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const calls = [];
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async (req) => {
      calls.push(req);
      return { json: decision({ zone: 'memory', action: 'merge_into', target: 'core-summary', title: '通用引擎新页' }), model: 'fake', usage: {} };
    } },
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
  });
  const receipt = inbox.addEntry({
    kind: 'save', content: '这是与健康或体重无关的一条通用引擎记录。',
    hint: 'path: knowledge/general-engine-note.md', client: 'policy-test', admission: admission('high', 'save', 'save'),
  });
  await receipt.synced;

  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(result.held, 0);
  assert.equal(calls.length, 1);
  assert.ok(existsSync(path.join(work, 'knowledge', 'general-engine-note.md')));
  assert.match(readFileSync(path.join(work, 'knowledge', 'general-engine-note.md'), 'utf8'), /与健康或体重无关/);
  assert.ok(!messages.some((m) => m.includes('待你定夺')), '普通 create-only 写入不应制造主人决策题');
});

test('模型首次越过 AdmissionContext、repair 改为合法 effect 后自动执行，不通知主人定夺', async () => {
  const { work } = gitInstance('policy-repair');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const calls = [];
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async (req) => {
      calls.push(req);
      const json = req.mode === 'repair'
        ? decision({ zone: 'knowledge', action: 'new_page', target: 'repaired-capture', title: '修正后的捕获' })
        : decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' });
      return { json, model: req.mode === 'repair' ? 'fake-repair' : 'fake-first', usage: {} };
    } },
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
  });
  const receipt = inbox.addEntry({
    kind: 'capture', content: '一条只能走新增型 effect 的普通捕获。', client: 'capture-app',
    admission: admission('capture', 'capture', 'capture'),
  });
  await receipt.synced;

  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(result.held, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].mode, 'repair');
  assert.equal(calls[1].escalate, true);
  assert.match(calls[1].user, /AdmissionContext|effect policy|重新出一份可执行决定/);
  assert.ok(existsSync(path.join(work, 'knowledge', 'repaired-capture.md')));
  assert.ok(!messages.some((m) => m.includes('待你定夺')), '可由模型受约束修正的问题不应通知主人决策');
});

test('capture hint 提到既有页不等于获得追加权限：受约束重规划后只新建独立页', async () => {
  const { work } = gitInstance('capture-target-hint');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const existing = path.join(work, 'knowledge', 'coffee-brewing.md');
  const before = readFileSync(existing, 'utf8');
  const calls = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async (req) => {
      calls.push(req);
      const json = req.mode === 'repair'
        ? decision({ zone: 'knowledge', action: 'new_page', target: 'captured-coffee-note', title: '咖啡摘记' })
        : decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' });
      return { json, model: 'fake', usage: {} };
    } },
    notifier: { notify: async () => ({ ok: true }) },
  });
  const receipt = inbox.addEntry({
    kind: 'capture', content: '一条来自软投递入口的咖啡资料。',
    hint: 'path: knowledge/coffee-brewing.md', client: 'capture-app',
    admission: admission('capture', 'capture', 'capture'),
  });
  await receipt.synced;

  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(result.held, 0);
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(existing, 'utf8'), before, '没有 target:explicit/page:append 时不得改既有页');
  assert.ok(existsSync(path.join(work, 'knowledge', 'captured-coffee-note.md')));
});

test('merge_into 遇到完全相同正文是幂等成功，不重复追加也不制造人工冲突', async () => {
  const instanceDir = fixtureCopy('exact-duplicate');
  const target = path.join(instanceDir, 'knowledge', 'coffee-brewing.md');
  const before = readFileSync(target, 'utf8');
  const a = admission('high', 'save', 'save');
  const entry = {
    ...policyEntry(a, 'save'),
    body: '水温 92 度，粉水比 1:15。浅烘豆用更高水温。',
  };
  const planned = decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' });
  const validation = validateDecisionPlan({ instanceDir, entry, decision: planned });
  assert.equal(validation.ok, true);

  const applied = await applyDecisionPlan({ instanceDir, entry, decision: planned, validation });
  assert.deepEqual(applied.changedPaths, []);
  assert.match(applied.detail, /完全相同正文|幂等/);
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('merge_into 幂等只认完整独立文本块，不吞掉既有长句中的短子串', async () => {
  const instanceDir = fixtureCopy('exact-block-only');
  const target = path.join(instanceDir, 'knowledge', 'coffee-brewing.md');
  const a = admission('high', 'save', 'save');
  const entry = { ...policyEntry(a, 'save'), body: '水温' };
  const planned = decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' });
  const validation = validateDecisionPlan({ instanceDir, entry, decision: planned });
  assert.equal(validation.ok, true);
  const applied = await applyDecisionPlan({ instanceDir, entry, decision: planned, validation });
  assert.deepEqual(applied.changedPaths, ['knowledge/coffee-brewing.md']);
  assert.match(readFileSync(target, 'utf8'), /keeper 归档[\s\S]*\n\n水温\n$/);
});

test('低置信 forbidden 保持拒收隔离，不得被 candidate fallback 改写成正式页', async () => {
  const { work } = gitInstance('low-forbidden');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async () => ({
      json: decision({
        disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'must-not-be-filed',
        confidence: 0.4, reject_reason: '疑似不应留存的内容',
      }),
      model: 'fake', usage: {},
    }) },
    notifier: { notify: async () => ({ ok: true }) },
  });
  const receipt = inbox.addEntry({
    kind: 'capture', content: '一条模型低置信判定不应留存的内容。', client: 'capture-app',
    admission: admission('capture', 'capture', 'capture'),
  });
  await receipt.synced;

  const result = await keeper.processPending();
  assert.equal(result.rejected, 1);
  assert.equal(result.filed, 0);
  assert.ok(!existsSync(path.join(work, 'knowledge', 'must-not-be-filed.md')));
  assert.ok(!existsSync(path.join(work, 'knowledge', `inbox-${receipt.id}.md`)));
  assert.match(readFileSync(path.join(work, receipt.path), 'utf8'), /^status: rejected$/m);
});

test('repair 后仍低置信的破坏性动作回到 owner-held，不得借重规划路径自动执行', async () => {
  const { work } = gitInstance('repair-low-remove');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async (req) => {
      if (req.mode === 'options') return { json: { options: [] }, model: 'fake-options', usage: {} };
      const json = req.mode === 'repair'
        ? decision({ zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing', confidence: 0.4 })
        : decision({ zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing', confidence: 0.95 });
      return { json, model: 'fake', usage: {} };
    } },
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
  });
  const receipt = inbox.addEntry({
    kind: 'remove', content: '删除手冲咖啡页', client: 'policy-test',
    admission: admission('high', 'remove', 'remove'),
  });
  await receipt.synced;

  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  assert.equal(result.filed, 0);
  assert.ok(existsSync(path.join(work, 'knowledge', 'coffee-brewing.md')));
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /^held_class: owner$/m);
  assert.ok(messages.some((text) => text.includes('待你定夺')));
});

test('owner-held 候选的 proof 刷新失败时恢复原收件，下轮可重试且不会留下不可点候选', async () => {
  const { work } = gitInstance('held-proof-atomic');
  const writer = createWriter({ instanceDir: work });
  const backing = new Map();
  let setCalls = 0;
  const nativeReg = {
    get: (id) => backing.get(id),
    has: (id) => backing.has(id),
    delete: (id) => backing.delete(id),
    set(id, token) {
      setCalls++;
      if (setCalls === 2) throw new Error('simulated proof persistence failure');
      backing.set(id, token);
      return this;
    },
  };
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async (req) => {
      if (req.mode === 'options') {
        return {
          json: { options: [{
            label: '标记唯一匹配的待办为完成',
            decision: decision({ zone: 'todo', action: 'todo_done', target: '给自行车换轮胎' }),
          }] },
          model: 'fake-options', usage: {},
        };
      }
      return {
        json: decision({ zone: 'todo', action: 'todo_done', target: '不存在的待办' }),
        model: 'fake', usage: {},
      };
    } },
    notifier: { notify: async () => ({ ok: true }) },
  });
  const receipt = inbox.addEntry({
    kind: 'todo_done', content: '把那条待办标完成', client: 'policy-test',
    admission: admission('high', 'todo_done', 'todo_done'),
  });
  await receipt.synced;
  const abs = path.join(work, receipt.path);
  const before = readFileSync(abs, 'utf8');
  const originalProof = backing.get(receipt.id);

  const failed = await keeper.processPending();
  assert.equal(failed.errors, 1);
  assert.equal(readFileSync(abs, 'utf8'), before, 'proof 失败须恢复事务前 pending 原文');
  assert.equal(backing.get(receipt.id), originalProof, '旧文件仍配旧 proof，不得半刷新');
  assert.equal(git(work, 'status', '--porcelain'), '');

  const retried = await keeper.processPending();
  assert.equal(retried.held, 1, '恢复后的 pending 件可在下轮正常转 owner-held');
  const heldRaw = readFileSync(abs, 'utf8');
  assert.match(heldRaw, /^status: held$/m);
  assert.match(heldRaw, /<!--keeper-options/);
  assert.equal(backing.get(receipt.id), nativeToken({
    id: receipt.id, rel: receipt.path, kind: 'todo_done', client: 'policy-test', raw: heldRaw,
  }), '候选文件与新 proof 必须一致');
});

test('retryable 连续失败到上限后停止自动重试，只发运维告警而不伪装成主人决策题', async () => {
  const { work } = gitInstance('retry-exhausted');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, doctor: false,
    provider: { judge: async () => { throw new Error('provider persistent outage'); } },
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
  });
  const receipt = inbox.addEntry({
    kind: 'save', content: '等待引擎恢复的普通记录', client: 'policy-test',
    admission: admission('high', 'save', 'save'),
  });
  await receipt.synced;
  const abs = path.join(work, receipt.path);
  writeFileSync(abs, readFileSync(abs, 'utf8').replace(/^status: pending$/m, 'retry_count: 5\nstatus: pending'));

  const first = await keeper.processPending();
  assert.equal(first.held, 1);
  const raw = readFileSync(abs, 'utf8');
  assert.match(raw, /^held_class: retryable$/m);
  assert.match(raw, /^retry_count: 6$/m);
  assert.match(raw, /^retry_exhausted: true$/m);
  assert.doesNotMatch(raw, /^retry_after:/m);
  assert.doesNotMatch(raw, /^keeper_held_at:/m);
  assert.ok(messages.some((text) => text.includes('自动重试已停止')));
  assert.ok(!messages.some((text) => text.includes('待你定夺')));

  const second = await keeper.processPending();
  assert.equal(second.processed, 0, '耗尽件不再按小时烧模型');
});

test('本地 commit 成功但远端同步失败仍算 filed，并明确记录 sync_pending', async () => {
  const { origin, work } = gitInstance('sync-pending');
  const intakeWriter = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer: intakeWriter, nativeReg });
  const receipt = inbox.addEntry({
    kind: 'save', content: '本地 durable 后等待同步的内容', client: 'policy-test',
    admission: admission('high', 'save', 'save'),
  });
  await receipt.synced;

  const keeperWriter = {
    transact: async (fn) => fn(async ({ paths, message }) => {
      git(work, 'add', '--', ...paths);
      git(work, 'commit', '-m', message);
      return { ok: false, error: 'simulated remote conflict' };
    }),
  };
  const audits = [];
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer: keeperWriter, nativeReg, doctor: false,
    provider: { judge: async () => ({
      json: decision({ zone: 'knowledge', action: 'new_page', target: 'local-durable-note', title: '本地已提交' }),
      model: 'fake', usage: {},
    }) },
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
    audit: (event) => audits.push(event),
  });

  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.ok(existsSync(path.join(work, 'knowledge', 'local-durable-note.md')));
  assert.ok(!existsSync(path.join(work, receipt.path)));
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(audits.find((event) => event.verdict === 'filed')?.sync_pending, true);
  assert.ok(messages.some((text) => text.includes('远端同步待重试')));
  assert.doesNotMatch(git(origin, 'ls-tree', '-r', '--name-only', 'HEAD'), /local-durable-note\.md/);
});
