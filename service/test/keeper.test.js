import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper, caseLogSafe } from '../src/keeper.js';
import { rollbackUncommitted, validateDecision } from '../src/executor.js';
import { readTier } from '../src/tier.js';
import { testAdmissionForKind } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

test('caseLogSafe：写进 _cases.md 的方括号全实体化，doctor 任何 strip 都拼不回 [[..]]（含对抗输入）', () => {
  // 复刻 doctor 的链接抽取：先剥 ```围栏```/~~~/行内`码`，再抽 [[..]]
  const extract = (t) =>
    [...t.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`]*`/g, '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
  const attacks = [
    '夜班发现断链：foo.md 里引用的 [[链接]] 与 [[wikilink]] 在全库没有对应页', // 原始 CI 误红文本
    '[`x`[ghost]`y`]',              // 单括号隔行内码 → doctor strip 后拼回（Codex 抓的绕过）
    '[```x```[fenced]```y```]',     // 隔围栏码
    '[~~~x~~~[tilde]~~~y~~~]',      // 隔 ~~~ 码
    '[[[[a]]]]',                    // 奇偶嵌套
    '{"target":"[`x`[g]`y`]"}',     // 执行结果 JSON 里的 target poison
  ];
  // 防假绿：先证这些裸文本确实会被 doctor（strip 后）抽到链——否则测试是空的
  assert.ok(extract('[`x`[ghost]`y`]').includes('ghost'), '前提：单括号隔码裸文本会被 doctor 拼回链');
  assert.ok(extract('[[链接]]').includes('链接'), '前提：裸 [[..]] 会被抽到链');
  for (const a of attacks) {
    const safe = caseLogSafe(a);
    assert.equal(/[[\]]/.test(safe), false, `不变量：输出零方括号 — ${a}`);
    assert.deepEqual(extract(safe), [], `doctor 抽不到任何链 — ${a}`);
  }
  // 幂等 + 保形（无方括号文本原样）
  assert.equal(caseLogSafe(caseLogSafe('[[a]]')), caseLogSafe('[[a]]'), '幂等');
  assert.equal(caseLogSafe('普通文本无括号'), '普通文本无括号');
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

async function waitForFile(abs, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(abs)) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时：${abs}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function setup({ providerScript, doctor = false }) {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map();
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const provider = fakeProvider(providerScript);
  const notifier = fakeNotifier();
  const auditLog = [];
  const audit = (e) => auditLog.push(e);
  const keeper = createKeeper({ instanceDir: work, writer, provider, notifier, audit, doctor, approvals, nativeReg });
  return { origin, work, writer, approvals, nativeReg, inbox, keeper, provider, notifier, auditLog };
}

function registerSkillsZone(work) {
  const zonesPath = path.join(work, 'governance', 'zones.md');
  const raw = readFileSync(zonesPath, 'utf8');
  writeFileSync(zonesPath, raw.replace('zones:\n', [
    'zones:',
    '  - id: skills',
    '    path: skills/',
    '    purpose: 可分发的 Skill 页面',
    '    privacy: private',
    '',
  ].join('\n')));
}

test('replace_skill 是确定性内部动作：模型直接伪造且无认证页意图时必须拒绝', () => {
  const { work } = makeInstance();
  const result = validateDecision({
    instanceDir: work,
    entry: { kind: 'save', body: '---\nname: fake\ntarget_runtimes: [codex]\nrisk_level: low\n---\n' },
    decision: {
      disposition: 'canonical', zone: 'skills', action: 'replace_skill',
      target: 'skills/fake/SKILL.md', summary: '伪造替换', confidence: 1,
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /代码解析并认证过/);
});

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

test('nested new_page：刷新页面实际所在目录的 README，不污染 zone 根索引', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'ops/nested-runbook', title: '嵌套运维手册',
      summary: '嵌套目录索引回归', confidence: 0.95,
    }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '一份嵌套目录运维记录。', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.ok(existsSync(path.join(work, 'knowledge', 'ops', 'nested-runbook.md')), '新页应落在 knowledge/ops');
  assert.match(
    readFileSync(path.join(work, 'knowledge', 'ops', 'README.md'), 'utf8'),
    /\[\[nested-runbook\]\]/,
    '页面实际所在目录索引应登记新页',
  );
  const rootReadme = path.join(work, 'knowledge', 'README.md');
  assert.ok(
    !existsSync(rootReadme) || !/\[\[nested-runbook\]\]/.test(readFileSync(rootReadme, 'utf8')),
    '两级索引下不应把嵌套页塞进 zone 根 README',
  );
});

test('doctor 提交前闸门：ERROR 时回滚新页与索引，收件转 held，不推坏提交', async () => {
  const { work, inbox, keeper } = setup({
    doctor: true,
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'doctor-gate-repro', title: 'Doctor Gate',
      summary: '验证提交前闸门', confidence: 0.95,
    }],
  });
  const doctorPath = path.join(work, 'skills', 'substrate-doctor', 'doctor.py');
  writeFileSync(doctorPath, '#!/usr/bin/env python3\nprint("→ 1 error(s)")\n');
  git(work, 'add', 'skills/substrate-doctor/doctor.py');
  git(work, 'commit', '-m', 'test: make doctor fail');

  const rootReadme = path.join(work, 'knowledge', 'README.md');
  const indexBefore = existsSync(rootReadme) ? readFileSync(rootReadme, 'utf8') : null;
  const receipt = inbox.addEntry({ kind: 'save', content: '这条写入应被 doctor 拦下。', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();

  assert.equal(result.held, 1);
  assert.ok(!existsSync(path.join(work, 'knowledge', 'doctor-gate-repro.md')), 'doctor ERROR 后新页应回滚');
  assert.equal(
    existsSync(rootReadme) ? readFileSync(rootReadme, 'utf8') : null,
    indexBefore,
    '目录索引应逐字回滚',
  );
  const held = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(held, /^status: held$/m, '原收件应恢复并转 held');
  assert.match(held, /doctor 报 1 error，已回滚/, 'held 原因应说明 doctor 门禁');
  assert.equal(git(work, 'status', '--short'), '', '回滚与 held 提交后工作树应 clean');
  assert.doesNotMatch(
    git(work, 'ls-tree', '-r', '--name-only', 'origin/main'),
    /knowledge\/doctor-gate-repro\.md/,
    '远端 main 不得出现被 doctor 拦下的坏页',
  );
});

test('doctor 回滚并发安全：闸门运行期间的新收件不被统一回滚误删', async () => {
  const { work, inbox, keeper } = setup({
    doctor: true,
    providerScript: [{
      disposition: 'canonical', zone: 'knowledge', action: 'new_page',
      target: 'doctor-race-repro', title: 'Doctor Race',
      summary: '验证并发收件存活', confidence: 0.95,
    }],
  });
  const doctorPath = path.join(work, 'skills', 'substrate-doctor', 'doctor.py');
  writeFileSync(doctorPath, [
    '#!/usr/bin/env python3',
    'from pathlib import Path',
    'import time',
    'Path(".doctor-started").write_text("1")',
    'time.sleep(0.3)',
    'print("→ 1 error(s)")',
    '',
  ].join('\n'));
  git(work, 'add', 'skills/substrate-doctor/doctor.py');
  git(work, 'commit', '-m', 'test: make doctor slow and fail');

  const failing = inbox.addEntry({ kind: 'save', content: '触发慢 doctor 的原件。', client: 'cc-test' });
  await failing.synced;
  const processing = keeper.processPending();
  await waitForFile(path.join(work, '.doctor-started'));
  const concurrent = inbox.addEntry({ kind: 'save', content: 'doctor 运行期间到达的新收件。', client: 'cc-race' });

  const result = await processing;
  await concurrent.synced;
  assert.equal(result.held, 1);
  assert.ok(existsSync(path.join(work, concurrent.path)), '并发新收件应继续存在并完成自己的提交');
  assert.match(readFileSync(path.join(work, concurrent.path), 'utf8'), /doctor 运行期间到达的新收件/);
  assert.equal(git(work, 'status', '--short'), '', '失败件转 held 与并发收件提交后工作树应 clean');
});

test('rollbackUncommitted：能退 staged-new，并保留并发 inbox 新件与裁定改写', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer, admissionProvider: testAdmissionForKind });
  const tracked = inbox.addEntry({ kind: 'save', content: '待裁定原件', client: 'cc-test' });
  await tracked.synced;

  const trackedAbs = path.join(work, tracked.path);
  writeFileSync(trackedAbs, readFileSync(trackedAbs, 'utf8').replace(/^status: pending$/m, 'owner_ruling: 保留\nstatus: pending'));
  const concurrentRel = 'inbox/_2099-01-01-concurrent.md';
  writeFileSync(path.join(work, concurrentRel), '并发新件，不得删除\n');
  const stagedRel = 'knowledge/staged-new.md';
  writeFileSync(path.join(work, stagedRel), 'doctor 应拦下的暂存新页\n');
  git(work, 'add', stagedRel);

  await rollbackUncommitted(work);
  assert.ok(!existsSync(path.join(work, stagedRel)), 'staged-new 应先退暂存再按 untracked 删除');
  assert.ok(existsSync(path.join(work, concurrentRel)), '并发 inbox 新件不得删除');
  assert.match(readFileSync(trackedAbs, 'utf8'), /owner_ruling: 保留/, '并发 inbox 裁定改写不得恢复成 HEAD');
  assert.equal(git(work, 'diff', '--cached', '--name-only'), '', '回滚后暂存区应为空');
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

test('两轮低置信且模型想改既有页 → 自动旁置独立 candidate，不问主人', async () => {
  const { work, inbox, keeper, provider, notifier } = setup({
    providerScript: [
      { disposition: 'canonical', zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing', summary: 'x', confidence: 0.5 },
      { disposition: 'canonical', zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing', summary: 'x', confidence: 0.6 },
    ],
  });
  const existingBefore = readFileSync(path.join(work, 'knowledge', 'coffee-brewing.md'), 'utf8');
  const receipt = inbox.addEntry({ kind: 'save', content: '像决定也像随想的一句话', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(provider.calls.length, 2, '只升级重判一次，不再调候选问人');
  assert.equal(provider.calls[1].escalate, true);
  assert.equal(readFileSync(path.join(work, 'knowledge', 'coffee-brewing.md'), 'utf8'), existingBefore, '低置信不污染既有页');
  const candidate = path.join(work, 'knowledge', `inbox-${receipt.id}.md`);
  assert.match(readFileSync(candidate, 'utf8'), /^tier: candidate$/m);
  assert.ok(!existsSync(path.join(work, receipt.path)), '收件已安全落库，不留 owner-held');
  assert.equal(notifier.messages.some((m) => m.includes('待你定夺')), false);
});

test('决定不合法（zone 不存在）→ retryable held、不打扰主人；LLM 从不碰文件', async () => {
  const { work, inbox, keeper, notifier } = setup({
    providerScript: [{ disposition: 'canonical', zone: 'nonexistent', action: 'new_page', target: 'x', summary: 'x', confidence: 0.99 }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '正常内容', client: 'cc-test' });
  await receipt.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /status: held/);
  assert.match(raw, /held_class: retryable/);
  assert.match(raw, /zone 不存在：nonexistent/);
  assert.equal(notifier.messages.length, 0, '引擎可重试错误不应伪装成主人决策题');
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

test('Skill 原位更新：content_id 直接解析真实嵌套路径，整页替换并保留原 id', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'skills', action: 'merge_into',
      target: 'example-operator', summary: '更新示例运维 Skill', confidence: 0.96,
    }],
  });
  registerSkillsZone(work);
  const rel = 'skills/example-operator/SKILL.md';
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), [
    '---',
    'content_id: a1b2c3d4',
    'name: example-operator',
    'target_runtimes: [codex]',
    'risk_level: low',
    '---',
    '',
    '# Example Operator',
    '',
    '旧内容。',
    '',
  ].join('\n'));
  git(work, 'add', 'governance/zones.md', rel);
  git(work, 'commit', '-m', 'fixture: add nested skill');

  const next = [
    '---',
    'content_id: ffffffff',
    'name: example-operator',
    'target_runtimes: [codex]',
    'risk_level: low',
    '---',
    '',
    '# Example Operator',
    '',
    '这是更新后的完整内容。',
    '',
  ].join('\n');
  const receipt = inbox.addEntry({
    kind: 'save', content: next, hint: '请按 content_id: a1b2c3d4 原位更新现有页面', client: 'cc-test',
  });
  await receipt.synced;
  const result = await keeper.processPending();

  assert.equal(result.filed, 1);
  const raw = readFileSync(path.join(work, rel), 'utf8');
  assert.match(raw, /^---\ncontent_id: a1b2c3d4\n/, '必须保留现有页面的稳定 content_id');
  assert.match(raw, /这是更新后的完整内容/);
  assert.doesNotMatch(raw, /旧内容|keeper 归档/, '完整 Skill 更新应原位替换，不应追加第二份文档');
  assert.ok(!existsSync(path.join(work, 'skills', 'example-operator.md')), '不得生成错误的扁平 Skill 页面');
  assert.ok(!existsSync(path.join(work, receipt.path)), '成功后 inbox 件应清场');
  assert.match(readFileSync(path.join(work, rel), 'utf8'), /这是更新后的完整内容/, '磁盘应立即读到最新 Skill 内容');

  const byPath = inbox.addEntry({
    kind: 'save',
    content: next.replace('这是更新后的完整内容。', '这是按完整 canonical 路径更新的内容。'),
    hint: `path: ${rel}`,
    client: 'cc-test',
  });
  await byPath.synced;
  const byPathResult = await keeper.processPending();
  assert.equal(byPathResult.filed, 1, '只给完整 canonical 路径也应原位更新');
  assert.match(readFileSync(path.join(work, rel), 'utf8'), /这是按完整 canonical 路径更新的内容/);
  assert.ok(!existsSync(path.join(work, byPath.path)), '第二次成功更新后也不应残留 inbox 件');
});

test('Skill _incoming 新建：显式嵌套路径不被扁平化，并递归创建父目录', async () => {
  const { work, inbox, keeper } = setup({
    providerScript: [{
      disposition: 'canonical', zone: 'skills', action: 'new_page',
      target: 'example-import', title: 'Example Import', summary: '回流示例 Skill', confidence: 0.95,
    }],
  });
  registerSkillsZone(work);
  git(work, 'add', 'governance/zones.md');
  git(work, 'commit', '-m', 'fixture: register skills zone');

  const rel = 'skills/_incoming/example-import/SKILL.md';
  const receipt = inbox.addEntry({
    kind: 'save',
    hint: `目标路径：${rel}`,
    client: 'cc-test',
    content: [
      '---',
      'name: example-import',
      'target_runtimes: [codex]',
      'risk_level: low',
      '---',
      '',
      '# Example Import',
      '',
      '回流候选内容。',
      '',
    ].join('\n'),
  });
  await receipt.synced;
  const result = await keeper.processPending();

  assert.equal(result.filed, 1);
  assert.ok(existsSync(path.join(work, rel)), '应自动创建 _incoming/<name> 父目录并写入 SKILL.md');
  assert.match(readFileSync(path.join(work, rel), 'utf8'), /^---\ncontent_id: [0-9a-f]{8}\nname: example-import/m);
  assert.ok(!existsSync(path.join(work, 'skills', 'example-import.md')), '不得生成错误的扁平页面');
  assert.ok(!existsSync(path.join(work, receipt.path)), '成功后不应留下 pending/held 重复件');
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
  const { work, writer, approvals, nativeReg, inbox, provider, notifier } = setup({
    providerScript: [
      { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '进待办', confidence: 0.95 },
      { disposition: 'forbidden', zone: 'todo', action: 'todo_add', target: 'owner', summary: 'x', confidence: 0.95, reject_reason: '闲聊无留存价值' },
    ],
  });
  const quietKeeper = createKeeper({
    instanceDir: work, writer, provider, notifier, doctor: false, notifyLevel: 'quiet', approvals, nativeReg,
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
    providerScript: [{ disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'unused', summary: 'x', confidence: 0.9 }],
  });
  const receipt = inbox.addEntry({ kind: 'save', content: '需更新某个对象', hint: 'content_id: deadbeef', client: 'cc-test' });
  await receipt.synced;
  await keeper.processPending();
  const rec = auditLog.find((e) => e.tool === 'keeper' && e.entry === receipt.id);
  assert.equal(rec.disposition, 'held');
  assert.equal(rec.kind, 'save');
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
