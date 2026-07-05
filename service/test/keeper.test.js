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
import { readTier } from '../src/tier.js';

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
  const auditLog = [];
  const audit = (e) => auditLog.push(e);
  const keeper = createKeeper({ instanceDir: work, writer, provider, notifier, audit, doctor: false });
  return { origin, work, inbox, keeper, provider, notifier, auditLog };
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
  assert.equal(provider.calls.length, 3, '升级重判一次 + held 后生成候选一次');
  assert.equal(provider.calls[1].escalate, true);
  assert.equal(provider.calls[2].mode, 'options');
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

test('埋点：filed 的审计条目记 disposition=accepted + kind', async () => {
  const { inbox, keeper, auditLog } = setup({
    providerScript: [{ disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '买猫粮', confidence: 0.97 }],
  });
  const receipt = inbox.addEntry({ kind: 'capture', content: '买猫粮', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.ok(rec, '应有 keeper 审计条目');
  assert.equal(rec.disposition, 'accepted', 'filed → disposition=accepted');
  assert.equal(rec.verdict, 'filed', 'verdict 旧字段保持不变（向后兼容）');
  assert.equal(rec.kind, 'capture', '带上件的 kind 供仪表分口径');
});

test('埋点：held 的审计条目记 disposition=held', async () => {
  const { inbox, keeper, auditLog } = setup({
    providerScript: [
      { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.5 },
      { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.6 },
    ],
  });
  const receipt = inbox.addEntry({ kind: 'capture', content: '拿不准的一句', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.disposition, 'held');
  assert.equal(rec.kind, 'capture');
});

test('埋点：rejected 的审计条目记 disposition=rejected', async () => {
  const { inbox, keeper, auditLog } = setup({
    providerScript: [{ disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x', confidence: 0.95, reject_reason: '闲聊无留存价值' }],
  });
  const receipt = inbox.addEntry({ kind: 'capture', content: '一次性闲聊', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.disposition, 'rejected');
});

// ==== M4.2 分层：写路径 ====

test('tier=candidate 落盘：新页 frontmatter 写 tier: candidate；审计 disposition=candidate（仍算已进库）', async () => {
  const { work, inbox, keeper, auditLog } = setup({
    providerScript: [{
      disposition: 'canonical', tier: 'candidate', zone: 'knowledge', action: 'new_page',
      target: 'maybe-note', title: '存疑一条', summary: '价值待验证', confidence: 0.9,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '也许有用的一段随笔。', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, 'candidate 仍是 filed（入库、不丢）');
  const raw = readFileSync(path.join(work, 'knowledge', 'maybe-note.md'), 'utf8');
  assert.equal(readTier(raw), 'candidate', '新页应带 tier: candidate');
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.verdict, 'filed', 'verdict 旧字段不变');
  assert.equal(rec.disposition, 'candidate', 'candidate 去向 → disposition=candidate（metrics 视为进库）');
  assert.equal(rec.tier, 'candidate');
});

test('缺陷3：upsert_row + tier=candidate 无 tier 落点 → 归一 canonical（落盘可见 + 审计 disposition=accepted/tier=canonical）', async () => {
  const { work, inbox, keeper, auditLog } = setup({
    providerScript: [{
      disposition: 'canonical', tier: 'candidate', zone: 'collections', action: 'upsert_row',
      target: 'restaurants', fields: { id: 'cand-place', name: '候选餐厅', city: '样例城' },
      summary: '收录 候选餐厅', confidence: 0.9,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'collection', payload: { name: 'restaurants', row: { name: '候选餐厅', city: '样例城' } }, client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  // CSV 无 tier 粒度 → 行照常落盘、默认可见
  assert.match(readFileSync(path.join(work, 'collections', 'restaurants', 'data.csv'), 'utf8'), /cand-place,候选餐厅,样例城/);
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.disposition, 'accepted', 'upsert_row 无 tier 落点 → 审计不谎报 candidate');
  assert.equal(rec.tier, 'canonical', '审计记录的是实际落盘的 tier=canonical（审计不说谎）');
});

test('tier 缺省即 canonical：模型不给 tier，新页写 tier: canonical（向后兼容）', async () => {
  const { work, inbox, keeper, auditLog } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'plain-fact', title: '普通事实', summary: '一条事实', confidence: 0.95,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '一条确定的事实。', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  assert.equal(readTier(readFileSync(path.join(work, 'knowledge', 'plain-fact.md'), 'utf8')), 'canonical');
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.disposition, 'accepted', '缺省 canonical → 旧口径 accepted 不变');
});

test('merge 不降级：candidate 合并进无 tier 的存量页 → 页仍 canonical（不被拉低、不凭空加行）', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', tier: 'candidate', zone: 'knowledge', action: 'merge_into',
      target: 'coffee-brewing', summary: '补充一句', confidence: 0.9,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '手冲补充：注水要匀。', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const raw = readFileSync(path.join(work, 'knowledge', 'coffee-brewing.md'), 'utf8');
  assert.equal(readTier(raw), 'canonical', '已 canonical（无 tier 视同）的页不因一次 candidate 合并被拉低');
  assert.ok(!/tier: candidate/.test(raw), '不该写入 candidate');
  assert.match(raw, /注水要匀/, '内容照常并入');
});

test('merge 可晋升：canonical 合并进 candidate 页 → 页升为 canonical', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [
      { disposition: 'canonical', tier: 'candidate', zone: 'knowledge', action: 'new_page', target: 'seedling', title: '幼苗页', summary: '存疑', confidence: 0.9 },
      { disposition: 'canonical', tier: 'canonical', zone: 'knowledge', action: 'merge_into', target: 'seedling', summary: '补权威内容', confidence: 0.95 },
    ],
  });
  const a = inbox.addEntry({ kind: 'save', content: '一条待验证的说法。', client: 'cc-test' });
  await a.synced;
  await keeper.processPending();
  assert.equal(readTier(readFileSync(path.join(work, 'knowledge', 'seedling.md'), 'utf8')), 'candidate');
  const b = inbox.addEntry({ kind: 'save', content: '权威来源已证实这一点。', client: 'cc-test' });
  await b.synced;
  await keeper.processPending();
  assert.equal(readTier(readFileSync(path.join(work, 'knowledge', 'seedling.md'), 'utf8')), 'canonical', 'canonical 并入 → 晋升');
});

test('非法 tier（如被注入产出 tier: admin）→ 决定校验不过 → held，不落盘', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [
      { disposition: 'canonical', tier: 'admin', zone: 'knowledge', action: 'new_page', target: 'x', title: 'x', summary: 'x', confidence: 0.99 },
      { disposition: 'canonical', tier: 'admin', zone: 'knowledge', action: 'new_page', target: 'x', title: 'x', summary: 'x', confidence: 0.99 },
    ],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '正常内容夹带 tier 越权', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1, '非法 tier → held');
  assert.ok(!existsSync(path.join(work, 'knowledge', 'x.md')), '不落盘');
});

test('lossless：keeper 主动拒收的低价值合法件不丢——留 inbox + status/tier: rejected（可复核可查）', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'x', summary: 'x',
      confidence: 0.9, reject_reason: '一次性闲聊，无留存价值',
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '哈哈今天真无聊。', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.rejected, 1);
  assert.ok(existsSync(path.join(work, receipt.path)), '拒收件不物理删除（lossless）');
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /status: rejected/);
  assert.equal(readTier(raw), 'rejected', 'frontmatter 打旗标 tier: rejected（隔离可查）');
});

test('主判异常 → 自动升级档重试成功 → filed 不打扰主人', async () => {
  const { work, inbox, keeper, provider, notifier } = setup({
    providerScript: [
      new Error('模型输出为空（finish_reason=length）'),
      { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '重试成功', confidence: 0.95 },
    ],
  });
  const receipt = inbox.addEntry({ kind: 'todo', content: '升级档兜住这条', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, '升级档成功就该归档');
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].escalate, true);
  assert.match(readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /升级档兜住这条/);
  assert.match(notifier.messages[0], /✅/);
});
