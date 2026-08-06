import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriter } from '../src/writer.js';
import { createAdmission, createInbox, parseEntryBody } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { validateDecisionPlan } from '../src/executor.js';
import { createNativeRegistry } from '../src/native-registry.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeGitInstance(name) {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-engine-audit-${name}-`));
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
  return { base, origin, work };
}

function fixtureCopy(name) {
  const instanceDir = mkdtempSync(path.join(tmpdir(), `substrate-engine-audit-${name}-`));
  cpSync(fixtureDir, instanceDir, { recursive: true });
  return instanceDir;
}

function admission(kind = 'save') {
  const ingress = kind === 'remove' ? 'remove' : 'save';
  return createAdmission({
    identity: { trust: 'high', source: 'audit-test', channel: 'primary' },
    ingress,
    kind,
  });
}

function decision(overrides = {}) {
  return {
    disposition: 'canonical',
    summary: 'engine audit',
    confidence: 0.99,
    ...overrides,
  };
}

function trackingProvider(handler) {
  const calls = [];
  return {
    calls,
    judge: async (request) => {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

const quietNotifier = { notify: async () => ({ ok: true }) };

test('高信任自由文本裁定不把普通 save 升级成 remove_page capability', async () => {
  const { work } = makeGitInstance('free-text-capability');
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map();
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg });
  const target = path.join(work, 'knowledge', 'coffee-brewing.md');
  const before = readFileSync(target, 'utf8');

  const receipt = inbox.addEntry({
    kind: 'save',
    content: '请把这条普通观察归档。',
    client: 'audit-client',
    admission: admission('save'),
  });
  await receipt.synced;
  const resolved = inbox.resolveEntry({
    id: receipt.id,
    ruling: '按你的判断归档，但不要改动已有页面',
    via: 'owner-primary',
    viaTrust: 'high',
    viaChannel: 'primary',
  });
  await resolved.synced;

  const remove = decision({ zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing' });
  const provider = trackingProvider(async () => ({ json: { ...remove }, model: 'fake', usage: {} }));
  const keeper = createKeeper({
    instanceDir: work,
    writer,
    approvals,
    nativeReg,
    provider,
    notifier: quietNotifier,
    doctor: false,
  });

  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  assert.equal(result.filed, 0);
  assert.equal(provider.calls.length, 2, '越权主判只允许一次受约束 repair，不得反复调用');
  assert.equal(readFileSync(target, 'utf8'), before, '自由文本裁定不能授予 page:remove');
  assert.match(readFileSync(path.join(work, receipt.path), 'utf8'), /^held_class: retryable$/m);
});

test('typed approval 持久化后跨 registry 重建直执行，且不调用 LLM', async () => {
  const { base, work } = makeGitInstance('approval-restart');
  const statePath = path.join(base, 'service-state', 'native-registry.json');
  const firstRegistry = createNativeRegistry({ statePath });
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({
    instanceDir: work,
    writer,
    nativeReg: firstRegistry,
    approvals: firstRegistry.approvals,
  });
  const approved = decision({
    zone: 'knowledge',
    action: 'new_page',
    target: 'owner-approved-after-restart',
    title: '重启后仍按点选执行',
  });
  const receipt = inbox.addEntry({
    kind: 'save',
    content: '这条内容必须按主人已经点选的目标归档。',
    client: 'audit-client',
    admission: admission('save'),
    status: 'held',
    optionsBlock: { options: [{ label: '建独立页', decision: approved }] },
  });
  await receipt.synced;
  const resolved = inbox.resolveEntry({
    id: receipt.id,
    option: 0,
    via: 'owner-primary',
    viaTrust: 'high',
    viaChannel: 'primary',
  });
  await resolved.synced;
  assert.equal(firstRegistry.approvals.has(receipt.id), true, '重启前批准 proof 已持久化');

  const restartedRegistry = createNativeRegistry({ statePath });
  assert.equal(restartedRegistry.has(receipt.id), true, '重启后 native proof 仍在');
  assert.equal(restartedRegistry.approvals.has(receipt.id), true, '重启后 typed approval 仍在');
  const provider = trackingProvider(async () => {
    assert.fail('主人点选的 typed plan 不应再交给 LLM');
  });
  const restartedKeeper = createKeeper({
    instanceDir: work,
    writer: createWriter({ instanceDir: work }),
    nativeReg: restartedRegistry,
    approvals: restartedRegistry.approvals,
    provider,
    notifier: quietNotifier,
    doctor: false,
  });

  const result = await restartedKeeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(provider.calls.length, 0);
  const filed = path.join(work, 'knowledge', 'owner-approved-after-restart.md');
  assert.match(readFileSync(filed, 'utf8'), /必须按主人已经点选的目标归档/);
  assert.equal(restartedRegistry.isConsumed(receipt.id), true, '终态前持久消费 native id');
  assert.equal(restartedRegistry.approvals.has(receipt.id), false, '终态同时销掉批准 proof');
});

test('文件带 owner 裁定标记但 approval proof 缺失时 security-held，且不交给 LLM', async () => {
  const { work } = makeGitInstance('missing-approval');
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map();
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg });
  const approved = decision({
    zone: 'knowledge',
    action: 'new_page',
    target: 'must-not-run-without-proof',
  });
  const receipt = inbox.addEntry({
    kind: 'save',
    content: '批准 proof 丢失时不得重新解释。',
    client: 'audit-client',
    admission: admission('save'),
    status: 'held',
    optionsBlock: { options: [{ label: '建独立页', decision: approved }] },
  });
  await receipt.synced;
  const resolved = inbox.resolveEntry({
    id: receipt.id,
    option: 0,
    via: 'owner-primary',
    viaTrust: 'high',
    viaChannel: 'primary',
  });
  await resolved.synced;
  approvals.clear();

  const provider = trackingProvider(async () => {
    assert.fail('缺 approval proof 的主人裁定件不得交给 LLM');
  });
  const keeper = createKeeper({
    instanceDir: work,
    writer,
    approvals,
    nativeReg,
    provider,
    notifier: quietNotifier,
    doctor: false,
  });
  const result = await keeper.processPending();

  assert.equal(result.held, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(existsSync(path.join(work, 'knowledge', 'must-not-run-without-proof.md')), false);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /^held_class: security$/m);
  assert.match(raw, /批准 proof 缺失|批准 proof/);
});

test('已消费 native id 的历史 inbox 重放后不能再次执行', async () => {
  const { base, work } = makeGitInstance('native-replay');
  const statePath = path.join(base, 'service-state', 'native-registry.json');
  const firstRegistry = createNativeRegistry({ statePath });
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({
    instanceDir: work,
    writer,
    nativeReg: firstRegistry,
    approvals: firstRegistry.approvals,
  });
  const target = path.join(work, 'knowledge', 'coffee-brewing.md');
  const targetRaw = readFileSync(target, 'utf8');
  const receipt = inbox.addEntry({
    kind: 'remove',
    content: '删除手冲咖啡页。',
    client: 'audit-client',
    admission: admission('remove'),
  });
  await receipt.synced;
  const historicalInboxRaw = readFileSync(path.join(work, receipt.path), 'utf8');
  const removeProvider = trackingProvider(async () => ({
    json: decision({ zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing' }),
    model: 'fake',
    usage: {},
  }));
  const firstKeeper = createKeeper({
    instanceDir: work,
    writer,
    nativeReg: firstRegistry,
    approvals: firstRegistry.approvals,
    provider: removeProvider,
    notifier: quietNotifier,
    doctor: false,
  });
  const firstResult = await firstKeeper.processPending();
  assert.equal(firstResult.filed, 1);
  assert.equal(existsSync(target), false);
  assert.equal(firstRegistry.isConsumed(receipt.id), true);

  writeFileSync(target, targetRaw);
  mkdirSync(path.dirname(path.join(work, receipt.path)), { recursive: true });
  writeFileSync(path.join(work, receipt.path), historicalInboxRaw);
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'restore historical inbox for replay test');
  git(work, 'push');

  const restartedRegistry = createNativeRegistry({ statePath });
  assert.equal(restartedRegistry.isConsumed(receipt.id), true, '消费 tombstone 跨重启保留');
  assert.equal(restartedRegistry.has(receipt.id), false);
  const replayProvider = trackingProvider(async () => {
    assert.fail('历史重放件不应进入 LLM');
  });
  const replayKeeper = createKeeper({
    instanceDir: work,
    writer: createWriter({ instanceDir: work }),
    nativeReg: restartedRegistry,
    approvals: restartedRegistry.approvals,
    provider: replayProvider,
    notifier: quietNotifier,
    doctor: false,
  });
  const replayResult = await replayKeeper.processPending();

  assert.equal(replayResult.held, 1);
  assert.equal(replayProvider.calls.length, 0);
  assert.equal(readFileSync(target, 'utf8'), targetRaw, '重放删除件不能再次删除新恢复的页面');
  assert.match(readFileSync(path.join(work, receipt.path), 'utf8'), /^held_class: security$/m);
});

test('用户正文里的 keeper held 字样不会被 parseEntryBody 静默截断', async () => {
  const instanceDir = mkdtempSync(path.join(tmpdir(), 'substrate-engine-audit-marker-'));
  mkdirSync(path.join(instanceDir, 'inbox'), { recursive: true });
  const nativeReg = new Map();
  const inbox = createInbox({
    instanceDir,
    nativeReg,
    writer: { commitAndPush: async () => ({ ok: true }) },
  });
  const receipt = inbox.addEntry({
    kind: 'save',
    content: '正文前半\n---\n**keeper held**（这只是用户文字）：不要截断\n正文后半',
    client: 'audit-client',
    admission: admission('save'),
  });
  await receipt.synced;

  const raw = readFileSync(path.join(instanceDir, receipt.path), 'utf8');
  const parsed = parseEntryBody(raw);
  assert.match(parsed.content, /正文前半/);
  assert.match(parsed.content, /keeper&#32;held/);
  assert.match(parsed.content, /正文后半/);
});

test('主判低置信后升级模型返回 json:null 时变 retryable-held，不热循环', async () => {
  const { work } = makeGitInstance('null-escalation');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, approvals });
  const provider = trackingProvider(async (_request, callNo) => {
    if (callNo === 1) {
      return {
        json: decision({
          zone: 'knowledge',
          action: 'new_page',
          target: 'low-confidence-first-pass',
          confidence: 0.2,
        }),
        model: 'fake-fast',
        usage: {},
      };
    }
    return { json: null, model: 'fake-escalated', usage: {} };
  });
  const keeper = createKeeper({
    instanceDir: work,
    writer,
    nativeReg,
    approvals,
    provider,
    notifier: quietNotifier,
    doctor: false,
  });
  const receipt = inbox.addEntry({
    kind: 'save',
    content: '升级模型输出坏 JSON 时应退避重试。',
    client: 'audit-client',
    admission: admission('save'),
  });
  await receipt.synced;

  const first = await keeper.processPending();
  assert.equal(first.held, 1);
  assert.equal(first.errors, 0);
  assert.equal(provider.calls.length, 2);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /^held_class: retryable$/m);
  assert.match(raw, /^retry_count: 1$/m);
  assert.match(raw, /^retry_after: /m);
  assert.equal(existsSync(path.join(work, 'knowledge', 'low-confidence-first-pass.md')), false);

  const immediateRetry = await keeper.processPending();
  assert.equal(immediateRetry.processed, 0, 'retry_after 到期前不得立即重进循环');
  assert.equal(provider.calls.length, 2);
});

test('generic new_page/merge_into 不能绕过 todo/collections typed-zone effects', () => {
  const instanceDir = fixtureCopy('typed-zones');
  const admitted = admission('save');
  const entry = {
    id: 'typed-zone-audit',
    kind: 'save',
    client: 'audit-client',
    body: '不能借普通 Markdown effect 改 typed zone。',
    admission: admitted,
    __native: true,
    __admission_enforced: true,
    __capabilities: [...admitted.capabilities],
  };
  const attempts = [
    decision({ zone: 'todo', action: 'new_page', target: 'audit-new' }),
    decision({ zone: 'todo', action: 'merge_into', target: 'owner' }),
    decision({ zone: 'collections', action: 'new_page', target: 'audit-new' }),
    decision({ zone: 'collections', action: 'merge_into', target: 'restaurants' }),
  ];

  for (const attempted of attempts) {
    const result = validateDecisionPlan({ instanceDir, entry, decision: attempted });
    assert.equal(result.ok, false, `${attempted.action} 不得写 ${attempted.zone}`);
    assert.equal(result.holdClass, 'security');
    assert.match(result.reason, /typed zone/);
  }
});

test('模型判断期间主人重新裁定：旧快照不得覆盖文件或销掉新 approval', async () => {
  const { work } = makeGitInstance('ruling-race');
  const writer = createWriter({ instanceDir: work });
  const nativeReg = new Map();
  const approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, approvals });
  const receipt = inbox.addEntry({
    kind: 'save', content: '并发裁定应以主人最新指示为准。', client: 'audit-client', admission: admission('save'),
  });
  await receipt.synced;

  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const provider = {
    judge: async () => {
      calls++;
      if (calls === 1) {
        signalStarted();
        await gate;
        return { json: decision({ zone: 'knowledge', action: 'new_page', target: 'stale-model-plan' }), model: 'slow-old', usage: {} };
      }
      return { json: decision({ zone: 'knowledge', action: 'new_page', target: 'latest-owner-plan' }), model: 'fresh', usage: {} };
    },
  };
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg, approvals, provider, notifier: quietNotifier, doctor: false,
  });

  const staleRun = keeper.processPending();
  await started;
  const resolved = inbox.resolveEntry({
    id: receipt.id,
    ruling: '按最新裁定建独立页，旧模型结果作废',
    via: 'owner-primary',
    viaTrust: 'high',
    viaChannel: 'primary',
  });
  await resolved.synced;
  const currentApproval = approvals.get(receipt.id);
  assert.ok(currentApproval);
  releaseFirst();

  const staleResult = await staleRun;
  assert.equal(staleResult.errors, 1, '旧快照应作为并发失效退出，而不是落盘或 held 覆盖');
  assert.equal(existsSync(path.join(work, 'knowledge', 'stale-model-plan.md')), false);
  assert.equal(approvals.get(receipt.id), currentApproval, '旧轮不得销掉新裁定 proof');
  assert.match(readFileSync(path.join(work, receipt.path), 'utf8'), /owner_ruling: 按最新裁定建独立页/);

  const freshResult = await keeper.processPending();
  assert.equal(freshResult.filed, 1);
  assert.match(readFileSync(path.join(work, 'knowledge', 'latest-owner-plan.md'), 'utf8'), /并发裁定应以主人最新指示为准/);
});
