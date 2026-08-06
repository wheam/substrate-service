import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox, nativeToken } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { testAdmissionForKind } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-resolve-'));
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

test('listEntries：返回 inbox 全部件与状态', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer, admissionProvider: testAdmissionForKind });
  const a = inbox.addEntry({ kind: 'save', content: '第一条', client: 'cc-test' });
  const b = inbox.addEntry({ kind: 'todo', content: '第二条', client: 'cc-test' });
  await Promise.all([a.synced, b.synced]);
  const { entries } = inbox.listEntries();
  assert.equal(entries.length, 2);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.ok(entries.every((e) => e.status === 'pending'));
  assert.ok(entries.every((e) => e.excerpt.length > 0));
});

test('resolveEntry：写入主人裁定并复位 pending；未知 id 报可读错误', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer, admissionProvider: testAdmissionForKind });
  const r = inbox.addEntry({ kind: 'save', content: '拿不准的内容', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这条进 todo' });
  await resolved.synced;
  const raw = readFileSync(path.join(work, r.path), 'utf8');
  assert.match(raw, /status: pending/);
  assert.match(raw, /owner_ruling: 这条进 todo/);
  assert.throws(() => inbox.resolveEntry({ id: 'nope', ruling: 'x' }), /找不到|nope/);
});

test('keeper：主人裁定进 prompt、按裁定执行、判例自动落 _cases.md', async () => {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map(); // F1：inbox 与 keeper 共享同一批准登记表（resolveEntry 记账、keeper 核验）
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const calls = [];
  const provider = {
    judge: async (req) => {
      calls.push(req);
      return {
        json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '按裁定进待办', confidence: 0.99 },
        model: 'flash', usage: {},
      };
    },
  };
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider, approvals, nativeReg,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'save', content: '给猫买磨爪板', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这是待办不是知识，进 todo', via: 'test-owner', viaTrust: 'high' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.match(calls[0].user, /主人裁定.*进 todo/s, '裁定应进判断材料');
  assert.match(readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /给猫买磨爪板/);
  const cases = readFileSync(path.join(work, 'keeper-feedback', '_cases.md'), 'utf8');
  assert.match(cases, new RegExp(r.id));
  assert.match(cases, /这是待办不是知识/);
  assert.match(git(origin, 'log', '--oneline', '-2'), /keeper/);
});

test('注入防御 e2e：capture 正文/裁定里的 [[..]] 及绕过构造，归档进 _cases.md 后 doctor 抽不到任何断链', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map();
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const keeper = createKeeper({
    instanceDir: work, writer, approvals, nativeReg,
    provider: { judge: async () => ({ json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '进待办', confidence: 0.99 }, model: 'flash', usage: {} }) },
    notifier: { notify: async () => ({ ok: true }) }, doctor: false,
  });
  // capture 正文含「单括号隔行内码」绕过构造 + 裸 [[..]]；裁定也塞一个 [[..]]
  const r = inbox.addEntry({ kind: 'save', content: '记一条：[`x`[ghost-e2e]`y`] 以及 [[naked]]', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '进 todo，注意 [[wikilink]] 示例', via: 'test-owner', viaTrust: 'high' });
  await resolved.synced;
  await keeper.processPending();
  const cases = readFileSync(path.join(work, 'keeper-feedback', '_cases.md'), 'utf8');
  // 硬不变量：归档后一个裸方括号都不剩 → doctor 无论怎么 strip 都拼不回 [[..]]
  assert.equal(/[[\]]/.test(cases), false, `_cases.md 不得含裸方括号：\n${cases}`);
  const extract = (t) => [...t.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`]*`/g, '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  assert.deepEqual(extract(cases), [], 'doctor 在 _cases.md 抽不到任何链');
});

test('capture 通道的裁定无权触发删页：remove_page 校验直接不过', async () => {
  const { work } = makeInstance();
  const { validateDecision } = await import('../src/executor.js');
  const decision = { disposition: 'canonical', zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing', summary: 's', confidence: 0.99 };
  // F1：认证与通道都来自 keeper 查批准登记表后置的机器字段（__ruling_authentic / __ruling_trust=registry 里的
  // viaTrust），executor 不再信文件里裸的 owner_ruling/ruling_via_trust——伪造件改写这些 frontmatter 无效。
  const viaApp = validateDecision({ instanceDir: work, decision, entry: { __ruling_authentic: true, __ruling_trust: 'capture' } });
  assert.equal(viaApp.ok, false);
  assert.match(viaApp.reason, /无权删除|capture/);
  const viaHighText = validateDecision({ instanceDir: work, decision, entry: { __ruling_authentic: true, __ruling_trust: 'high' } });
  assert.equal(viaHighText.ok, false, '高信任自由文本只给 LLM 语义，不得变成全 effect capability');
  const viaHighTyped = validateDecision({
    instanceDir: work,
    decision,
    entry: { __ruling_authentic: true, __ruling_trust: 'high', approved_decision: decision },
  });
  assert.equal(viaHighTyped.ok, true, '高信任点选且 token 绑定的 typed plan 可授权精确删页动作');
});

test('listEntries：正文干净（不含 keeper 注记）、解析 held 人话原因与候选方案', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  // 二轮加固：native 绑定改内容绑定（含 options 原文）。本测试手工模拟 keeper 置 held + 写候选块——须同款
  // 模拟 keeper.holdEntry 对 native 件的【绑定刷新】（加了 options 就重绑 nativeReg），否则内容绑定 gate 会把
  // 手工注入的 merge_into（破坏性）候选当作篡改挡下。补这一步后，本用例即成「合法 native held 件的破坏性候选可点选」的正向覆盖。
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg, admissionProvider: testAdmissionForKind });
  const r = inbox.addEntry({ kind: 'save', content: '原始内容一句话', client: 'cc-test' });
  await r.synced;
  // 模拟 keeper 置 held + 写候选方案块
  const fs = await import('node:fs');
  const abs = path.join(work, r.path);
  let raw = fs.readFileSync(abs, 'utf8').replace(/^status: pending$/m, 'status: held');
  raw += `\n---\n**keeper held**（2026-07-05T02:00:00Z）：local-only 在服务端无意义；keeper 决定 {"zone":"memory"}\n`;
  raw += `\n<!--keeper-options\n${JSON.stringify({ options: [
    { label: '存为临时旅行记忆（过期不保留）', decision: { disposition: 'canonical', zone: 'memory', action: 'merge_into', target: 'platforms-devices-and-smart-home', summary: 's1', confidence: 0.9 } },
    { label: '扔掉别存', decision: { disposition: 'forbidden', zone: 'memory', action: 'merge_into', target: 'x', summary: 's2', confidence: 0.9, reject_reason: '主人选择不保存' } },
  ] })}\n-->\n`;
  fs.writeFileSync(abs, raw);
  // 同 keeper.holdEntry：native 件写了 options 后刷新内容绑定（含新 options 原文），令主人点选合法候选不被误挡。
  nativeReg.set(r.id, nativeToken({ id: r.id, rel: r.path, kind: 'save', client: 'cc-test', raw }));
  const e = inbox.listEntries().entries.find((x) => x.id === r.id);
  assert.equal(e.content, '原始内容一句话', '正文不应包含 keeper 注记与候选块');
  assert.match(e.reason, /local-only 在服务端无意义/);
  assert.ok(!e.reason.includes('{'), '人话原因不应带原始 JSON');
  assert.equal(e.options.length, 2);
  assert.equal(e.options[0].label, '存为临时旅行记忆（过期不保留）');

  // 选项裁定：resolveEntry({option:0}) → owner_ruling=label + 预批决定块
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const after = fs.readFileSync(abs, 'utf8');
  assert.match(after, /status: pending/);
  assert.match(after, /owner_ruling: 存为临时旅行记忆/);
  assert.match(after, /<!--owner-decision/);
});

test('keeper：预批决定直接执行不再重判；held 时自动生成候选方案块并在通知里列出', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map(); // F1：inbox 与 keeper 共享同一批准登记表
  const nativeReg = new Map(); // SEC-5 二/三轮：inbox 与 keeper 须共享亲生登记表（生产 createApp 经 app.locals 同款接线）
                               // ——keeper.holdEntry 生成 options 时刷新绑定，resolveEntry 才认得这份合法候选。
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const calls = [];
  const provider = {
    judge: async (req) => {
      calls.push(req);
      if (req.mode === 'options') {
        return { json: { options: [
          { label: '方案A：建独立页', decision: { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'owner-chosen-note', title: '主人选定的页', summary: 'A', confidence: 0.9 } },
          { label: '方案B：扔掉', decision: { disposition: 'forbidden', zone: 'knowledge', action: 'new_page', target: 'unused', summary: 'B', confidence: 0.9, reject_reason: '不保存' } },
        ] }, model: 'pro', usage: {} };
      }
      return { json: { disposition: 'canonical', zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing', summary: 'x', confidence: 0.5 }, model: 'flash', usage: {} };
    },
  };
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider, approvals, nativeReg,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  // 不存在的 content_id 是真实身份歧义，确定性进入 owner-held；provider 只负责生成可点选候选。
  const r = inbox.addEntry({ kind: 'save', content: '让目标解析失败的内容', hint: 'content_id: deadbeef', client: 'cc-test' });
  await r.synced;
  const round1 = await keeper.processPending();
  assert.equal(round1.held, 1);
  const e = inbox.listEntries().entries.find((x) => x.id === r.id);
  assert.equal(e.options.length, 2, 'held 后应带 pro 生成的候选');
  assert.match(messages[0], /方案A：建独立页/, '通知应列出候选');

  // 主人点了方案A → 预批决定直接执行（不再调 judge）
  const before = calls.length;
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'high' });
  await resolved.synced;
  const round2 = await keeper.processPending();
  assert.equal(round2.filed, 1);
  assert.equal(calls.length, before, '预批决定不应再调用 LLM');
  const fs2 = await import('node:fs');
  assert.match(fs2.readFileSync(path.join(work, 'knowledge', 'owner-chosen-note.md'), 'utf8'), /让目标解析失败的内容/);
});

test('主人裁定的拒收：件直接清场（git 留痕）+ 记判例；keeper 主动拒收仍保留待复核', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map(); // F1：inbox 与 keeper 共享同一批准登记表
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const provider = { judge: async (req) => req.mode === 'options'
    ? { json: { options: [] }, model: 'pro', usage: {} }
    : { json: { disposition: 'forbidden', zone: 'todo', action: 'todo_add', target: 'owner', summary: 's', confidence: 0.9, reject_reason: '主人选择不保存' }, model: 'flash', usage: {} } };
  const keeper = createKeeper({
    instanceDir: work, writer, provider, approvals, nativeReg,
    notifier: { notify: async () => ({ ok: true }) }, doctor: false,
  });
  const r = inbox.addEntry({ kind: 'save', content: '要被扔掉的内容', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '扔掉别存', via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.rejected, 1);
  const fs3 = await import('node:fs');
  assert.ok(!fs3.existsSync(path.join(work, r.path)), '主人裁定的拒收应从 inbox 清场');
  assert.match(fs3.readFileSync(path.join(work, 'keeper-feedback', '_cases.md'), 'utf8'), /扔掉别存/, '裁定应进判例');
});
