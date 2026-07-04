import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

// 每个测试独立实例，避免状态串扰
function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-keeper-'));
  const origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  return { origin, work };
}

function fakeProvider(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    judge: async (req) => {
      calls.push(req);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step instanceof Error) throw step;
      return { json: step, model: req.escalate ? 'pro' : 'flash', usage: { total_tokens: 10 } };
    },
  };
}

function fakeNotifier() {
  const messages = [];
  return { messages, notify: async (text) => { messages.push(text); return { ok: true }; } };
}

function setup({ providerScript }) {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const provider = fakeProvider(providerScript);
  const notifier = fakeNotifier();
  const keeper = createKeeper({ instanceDir: work, writer, provider, notifier, doctor: false });
  return { origin, work, inbox, keeper, provider, notifier };
}

test('save→knowledge new_page：建页、reindex、删收件、commit、通知', async () => {
  const { origin, work, inbox, keeper, notifier } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'espresso-basics', title: '意式浓缩要点',
      summary: '意式浓缩萃取参数', confidence: 0.93,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '意式浓缩 92 度 9bar 萃取 25-30 秒。', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.processed, 1);
  const page = path.join(work, 'knowledge', 'espresso-basics.md');
  assert.ok(existsSync(page), '应建页');
  const raw = readFileSync(page, 'utf8');
  assert.match(raw, /title: 意式浓缩要点/);
  assert.match(raw, /92 度 9bar/);
  assert.match(readFileSync(path.join(work, 'knowledge', 'README.md'), 'utf8'), /\[\[espresso-basics\]\]/);
  assert.ok(!existsSync(path.join(work, receipt.path)), 'filed 后收件应移除');
  assert.match(git(origin, 'log', '--oneline', '-2'), /keeper/);
  assert.equal(notifier.messages.length, 1);
  assert.match(notifier.messages[0], /✅.*已存/s);
});

test('todo kind → todo_add 按编号追加到 ## 待办', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{ disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '买猫粮', confidence: 0.97 }],
  });
  const receipt = inbox.addEntry({ kind: 'todo', content: '买猫粮', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const todo = readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8');
  assert.match(todo, /3\. 买猫粮/); // fixture 已有 1、2 两条
});

test('collection kind → collections.py upsert 真写主表', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'collections', action: 'upsert_row',
      target: 'restaurants', fields: { id: 'new-place', name: '新地方', city: '样例城' },
      summary: '收录 新地方', confidence: 0.9,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'collection', payload: { name: 'restaurants', row: { name: '新地方', city: '样例城' } }, client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  assert.match(readFileSync(path.join(work, 'collections', 'restaurants', 'data.csv'), 'utf8'), /new-place,新地方,样例城/);
});

test('两轮低置信 → held 不猜、通知待定夺、件保留', async () => {
  const { work, inbox, keeper, provider, notifier } = setup({
    providerScript: [
      { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.5 },
      { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.6 },
    ],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '像决定也像随想的一句话', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  assert.equal(provider.calls.length, 2, '应升级重判一次');
  assert.equal(provider.calls[1].escalate, true);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /status: held/);
  assert.match(notifier.messages[0], /🤔.*待你定夺/s);
});

test('决定不合法（zone 不存在）→ held + 可读理由；LLM 从不碰文件', async () => {
  const { work, inbox, keeper, notifier } = setup({
    providerScript: [{ disposition: 'canonical', zone: 'nonexistent', action: 'new_page', target: 'x', summary: 'x', confidence: 0.99 }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '正常内容', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  assert.match(readFileSync(path.join(work, receipt.path), 'utf8'), /status: held/);
  assert.match(notifier.messages[0], /nonexistent|不存在|校验/);
});

test('disposition=forbidden → rejected + 理由留在件里', async () => {
  const { work, inbox, keeper, notifier } = setup({
    providerScript: [{ disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.95, reject_reason: '含第三方隐私，按宪法不入库' }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '别人家的八卦', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.rejected, 1);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /status: rejected/);
  assert.match(raw, /第三方隐私/);
  assert.match(notifier.messages[0], /❌.*拒收.*第三方隐私/s);
});

test('LLM 异常（如 API 挂）→ held，不丢件不崩', async () => {
  const { work, inbox, keeper } = setup({ providerScript: [new Error('DeepSeek API 500')] });
  const receipt = inbox.addEntry({ kind: 'save', content: '内容', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  assert.ok(existsSync(path.join(work, receipt.path)));
});

test('merge_into：追加到既有页并 bump updated', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'merge_into',
      target: 'coffee-brewing', summary: '补充手冲细节', confidence: 0.88,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '手冲闷蒸 30 秒更均匀。', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const raw = readFileSync(path.join(work, 'knowledge', 'coffee-brewing.md'), 'utf8');
  assert.match(raw, /闷蒸 30 秒/);
  assert.match(raw, /keeper 归档/);
});

test('new_page 带 links：真实页写成 [[wikilink]]，不存在的丢弃', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'latte-art', title: '拉花要点', links: ['coffee-brewing', 'no-such-page'],
      summary: '拉花笔记', confidence: 0.9,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '拉花先打奶泡。', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const raw = readFileSync(path.join(work, 'knowledge', 'latte-art.md'), 'utf8');
  assert.match(raw, /相关：.*\[\[coffee-brewing\]\]/);
  assert.ok(!raw.includes('[[no-such-page]]'), '不存在的页不该被硬凑成链接');
});

test('notifyLevel=quiet：已存不播报，held/rejected 照常', async () => {
  const { work, inbox, provider, notifier } = setup({
    providerScript: [
      { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '进待办', confidence: 0.95 },
      { disposition: 'forbidden', zone: 'todo', action: 'todo_add', target: 'owner', summary: 'x', confidence: 0.95, reject_reason: '闲聊无留存价值' },
    ],
  });
  const quietKeeper = createKeeper({
    instanceDir: work, writer: createWriter({ instanceDir: work }), provider, notifier, doctor: false, notifyLevel: 'quiet',
  });
  const a = inbox.addEntry({ kind: 'todo', content: '安静存一条', client: 'cc-test' });
  await a.synced;
  await quietKeeper.processPending();
  assert.equal(notifier.messages.length, 0, 'quiet 下 filed 不播报');
  const b = inbox.addEntry({ kind: 'save', content: '会被拒的闲聊', client: 'cc-test' });
  await b.synced;
  await quietKeeper.processPending();
  assert.equal(notifier.messages.length, 1, '拒收必须照常播报');
  assert.match(notifier.messages[0], /拒收/);
});
