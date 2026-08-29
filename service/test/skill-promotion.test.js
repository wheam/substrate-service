import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
import { createWriter } from '../src/writer.js';
import { createAdmission, createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import {
  inspectSkillDirectory, PROMOTION_AUDIT_REL, requestSkillPromotion,
} from '../src/skill-promotion.js';
import { testAdmissionForKind } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance({ doctorFails = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-skill-promote-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seed, { recursive: true });
  const zonesPath = path.join(seed, 'governance', 'zones.md');
  writeFileSync(zonesPath, readFileSync(zonesPath, 'utf8').replace('zones:\n', [
    'zones:',
    '  - id: skills',
    '    path: skills/',
    '    purpose: 可分发的 Skill 页面',
    '    privacy: private',
    '',
  ].join('\n')));
  if (doctorFails) writeFileSync(path.join(seed, 'skills', 'substrate-doctor', 'doctor.py'), 'print("→ 1 error(s)")\n');
  git(seed, 'init', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  return { base, origin, work };
}

function setup(options = {}) {
  const { work, origin } = makeInstance(options);
  const writer = createWriter({ instanceDir: work });
  const approvals = new Map();
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals, nativeReg, admissionProvider: testAdmissionForKind });
  const calls = [];
  const provider = { judge: async (req) => { calls.push(req); throw new Error('Skill deterministic path 不应调用 LLM'); } };
  const messages = [];
  const audit = [];
  const keeper = createKeeper({
    instanceDir: work, writer, approvals, nativeReg, provider,
    notifier: { notify: async (text) => { messages.push(text); return { ok: true }; } },
    audit: (e) => audit.push(e), doctor: false,
  });
  return { work, origin, writer, approvals, nativeReg, inbox, keeper, calls, messages, audit };
}

function highPrimaryAdmission() {
  return createAdmission({
    identity: { trust: 'high', source: 'test', channel: 'primary' },
    ingress: 'promote_skill', kind: 'skill',
  });
}

function skillDoc(name, { risk = 'high', capabilities = '[shell, network, system]' } = {}) {
  return [
    '---',
    `name: ${name}`,
    'description: test skill',
    'reason: regression',
    'target_runtimes: [codex]',
    `risk_level: ${risk}`,
    `capabilities: ${capabilities}`,
    '---',
    '',
    `# ${name}`,
    '',
    '完整 Skill 根文档。',
    '',
  ].join('\n');
}

async function saveStage(s, rel, content) {
  const receipt = s.inbox.addEntry({ kind: 'save', hint: `path: ${rel}`, content, client: 'cc-stage' });
  await receipt.synced;
  const result = await s.keeper.processPending();
  return { receipt, result };
}

async function stageCompleteSkill(s, name = 'operating-test') {
  const root = await saveStage(s, `skills/_incoming/${name}/SKILL.md`, skillDoc(name));
  assert.equal(root.result.filed, 1);
  const ref = await saveStage(s, `skills/_incoming/${name}/references/runbook.md`, '# Runbook\n\n支持资料。\n');
  assert.equal(ref.result.filed, 1);
  const script = await saveStage(s, `skills/_incoming/${name}/scripts/check.py`, 'print("ok")\n');
  assert.equal(script.result.filed, 1);
  const agent = await saveStage(s, `skills/_incoming/${name}/agents/openai.yaml`, 'interface:\n  display_name: Test\n');
  assert.equal(agent.result.filed, 1);
  return inspectSkillDirectory(s.work, name);
}

async function requestReview(s, inspection) {
  const receipt = requestSkillPromotion({
    instanceDir: s.work, inbox: s.inbox, name: inspection.name,
    contentId: inspection.content_id, revision: inspection.revision,
    client: 'cc-requester', admission: highPrimaryAdmission(),
  });
  await receipt.synced;
  return receipt;
}

test('高风险 Skill：stage 完整目录 → owner 批准 → 原子晋升并写审计', async () => {
  const s = setup();
  const inspection = await stageCompleteSkill(s, 'operating-test');
  assert.equal(inspection.manifest.admission, 'manual-audit-required');
  assert.deepEqual(inspection.manifest.dangerous, ['network', 'shell', 'system']);
  const review = await requestReview(s, inspection);
  assert.equal(review.status, 'held');
  assert.equal(s.inbox.listEntries().entries.find((e) => e.id === review.id).options.length, 2);

  const approved = s.inbox.resolveEntry({
    id: review.id, option: 0, via: 'hermes-owner', viaTrust: 'high', viaChannel: 'primary',
  });
  await approved.synced;
  const result = await s.keeper.processPending();
  assert.equal(result.filed, 1);
  assert.equal(existsSync(path.join(s.work, 'skills', '_incoming', 'operating-test')), false);
  for (const rel of ['SKILL.md', 'references/runbook.md', 'scripts/check.py', 'agents/openai.yaml']) {
    assert.ok(existsSync(path.join(s.work, 'skills', 'operating-test', rel)), `${rel} 应随整目录晋升`);
  }
  const audit = readFileSync(path.join(s.work, PROMOTION_AUDIT_REL), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].approved_by, 'hermes-owner');
  assert.equal(audit[0].revision, inspection.revision);
  assert.equal(audit[0].result, 'promoted');
  assert.match(s.messages.at(-1), /Skill 已晋升/);
});

test('高风险 Skill 被 owner 拒绝：不进正式目录，staging 保留供修改', async () => {
  const s = setup();
  const inspection = await stageCompleteSkill(s, 'rejected-skill');
  const review = await requestReview(s, inspection);
  const rejected = s.inbox.resolveEntry({
    id: review.id, option: 1, via: 'hermes-owner', viaTrust: 'high', viaChannel: 'primary',
  });
  await rejected.synced;
  const result = await s.keeper.processPending();
  assert.equal(result.rejected, 1);
  assert.ok(existsSync(path.join(s.work, 'skills', '_incoming', 'rejected-skill', 'SKILL.md')));
  assert.equal(existsSync(path.join(s.work, 'skills', 'rejected-skill')), false);
});

test('根文件存在后 supporting file 可保存，且 supporting file 不要求 frontmatter', async () => {
  const s = setup();
  await saveStage(s, 'skills/_incoming/support-test/SKILL.md', skillDoc('support-test'));
  const body = 'interface:\n  display_name: Supporting file has no frontmatter\n';
  const out = await saveStage(s, 'skills/_incoming/support-test/agents/openai.yaml', body);
  assert.equal(out.result.filed, 1);
  assert.equal(readFileSync(path.join(s.work, 'skills/_incoming/support-test/agents/openai.yaml'), 'utf8'), body.trim());
  assert.equal(s.calls.length, 0, '显式 staging 路径应为确定性流程，不调用 LLM');
  assert.equal(s.messages.length, 0, '多文件 staging 成功不应逐文件通知；只在提交晋升审核时产生一条可操作通知');
});

test('根文件不存在时 supporting file fail closed，且不产生六次 retry', async () => {
  const s = setup();
  const out = await saveStage(s, 'skills/_incoming/no-root/scripts/x.py', 'print(1)\n');
  assert.equal(out.result.held, 1);
  const raw = readFileSync(path.join(s.work, out.receipt.path), 'utf8');
  assert.match(raw, /held_class: owner/);
  assert.doesNotMatch(raw, /retry_count:/);
  assert.equal(existsSync(path.join(s.work, 'skills/_incoming/no-root/scripts/x.py')), false);
  const notifications = s.messages.length;
  for (let i = 0; i < 6; i++) assert.equal((await s.keeper.processPending()).processed, 0);
  assert.equal(s.messages.length, notifications, '人工处理项不得因 keeper tick 重复通知');
});

test('manifest/frontmatter 无效与 name/目录不一致均拒绝 staging', async () => {
  for (const [name, body, pattern] of [
    ['bad-manifest', '# no frontmatter\n', /frontmatter|SKILL_MANIFEST_INVALID/],
    ['wanted-name', skillDoc('other-name'), /name.*目录|不一致/],
  ]) {
    const s = setup();
    const out = await saveStage(s, `skills/_incoming/${name}/SKILL.md`, body);
    assert.equal(out.result.held, 1);
    assert.equal(existsSync(path.join(s.work, `skills/_incoming/${name}/SKILL.md`)), false);
    assert.match(readFileSync(path.join(s.work, out.receipt.path), 'utf8'), pattern);
  }
});

test('正式目标冲突时安全失败，不允许覆盖既有 canonical Skill', async () => {
  const s = setup();
  const inspection = await stageCompleteSkill(s, 'conflict-skill');
  mkdirSync(path.join(s.work, 'skills', 'conflict-skill'), { recursive: true });
  writeFileSync(path.join(s.work, 'skills', 'conflict-skill', 'SKILL.md'), skillDoc('conflict-skill', { risk: 'low', capabilities: '[]' }));
  assert.throws(() => requestSkillPromotion({
    instanceDir: s.work, inbox: s.inbox, name: inspection.name,
    contentId: inspection.content_id, revision: inspection.revision,
    client: 'x', admission: highPrimaryAdmission(),
  }), /SKILL_TARGET_EXISTS|默认禁止覆盖/);
});

test('批准绑定整树 revision：supporting file 变化后旧批准过期，正式目录不落地', async () => {
  const s = setup();
  const inspection = await stageCompleteSkill(s, 'stale-skill');
  const review = await requestReview(s, inspection);
  const approved = s.inbox.resolveEntry({
    id: review.id, option: 0, via: 'owner', viaTrust: 'high', viaChannel: 'primary',
  });
  await approved.synced;
  // 批准后换 B：模拟 git pull / 外部变更；revision 必须挡住 approve-A/promote-B。
  writeFileSync(path.join(s.work, 'skills/_incoming/stale-skill/references/runbook.md'), '# changed after approval\n');
  git(s.work, 'add', 'skills/_incoming/stale-skill/references/runbook.md');
  git(s.work, 'commit', '-m', 'fixture: mutate staged tree after approval');
  const result = await s.keeper.processPending();
  assert.equal(result.held, 1);
  assert.equal(existsSync(path.join(s.work, 'skills', 'stale-skill')), false);
  const raw = readFileSync(path.join(s.work, review.path), 'utf8');
  assert.match(raw, /版本已过期|revision/);
  assert.match(raw, /held_class: owner/);
  assert.doesNotMatch(raw, /retry_count:/);
});

test('doctor 失败时目录与审计完整回滚，审核件 owner-held 且不自动重试', async () => {
  const s = setup({ doctorFails: true });
  const inspection = await stageCompleteSkill(s, 'doctor-fail-skill');
  const review = await requestReview(s, inspection);
  const approved = s.inbox.resolveEntry({
    id: review.id, option: 0, via: 'owner', viaTrust: 'high', viaChannel: 'primary',
  });
  await approved.synced;
  const strictKeeper = createKeeper({
    instanceDir: s.work, writer: s.writer, approvals: s.approvals, nativeReg: s.nativeReg,
    provider: { judge: async () => { throw new Error('Skill review 不应调用 LLM'); } },
    notifier: { notify: async (text) => { s.messages.push(text); return { ok: true }; }, },
    audit: (e) => s.audit.push(e), doctor: true,
  });
  const result = await strictKeeper.processPending();
  assert.equal(result.held, 1);
  assert.ok(existsSync(path.join(s.work, 'skills/_incoming/doctor-fail-skill/SKILL.md')), 'source 必须恢复');
  assert.equal(existsSync(path.join(s.work, 'skills/doctor-fail-skill')), false, '正式目标不得残留半目录');
  assert.equal(existsSync(path.join(s.work, PROMOTION_AUDIT_REL)), false, '失败审计写须回滚');
  const raw = readFileSync(path.join(s.work, review.path), 'utf8');
  assert.match(raw, /held_class: owner/);
  assert.doesNotMatch(raw, /retry_count:/);
  for (let i = 0; i < 6; i++) assert.equal((await strictKeeper.processPending()).processed, 0);
});

test('相同晋升请求幂等：待审不重复建通知对象，成功后返回 already_promoted', async () => {
  const s = setup();
  const inspection = await stageCompleteSkill(s, 'idempotent-skill');
  const first = await requestReview(s, inspection);
  const second = requestSkillPromotion({
    instanceDir: s.work, inbox: s.inbox, name: inspection.name,
    contentId: inspection.content_id, revision: inspection.revision,
    client: 'retry', admission: highPrimaryAdmission(),
  });
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  assert.equal(s.inbox.listEntries().entries.filter((e) => e.kind === 'skill').length, 1);
  const approved = s.inbox.resolveEntry({
    id: first.id, option: 0, via: 'owner', viaTrust: 'high', viaChannel: 'primary',
  });
  await approved.synced;
  assert.equal((await s.keeper.processPending()).filed, 1);
  const after = requestSkillPromotion({
    instanceDir: s.work, inbox: s.inbox, name: inspection.name,
    contentId: inspection.content_id, revision: inspection.revision,
    client: 'retry', admission: highPrimaryAdmission(),
  });
  assert.equal(after.already_promoted, true);
});

test('所有风险等级目前都需 owner review；低风险不自动晋升', async () => {
  const s = setup();
  await saveStage(s, 'skills/_incoming/low-risk/SKILL.md', skillDoc('low-risk', { risk: 'low', capabilities: '[read-markdown, write-markdown]' }));
  const inspection = inspectSkillDirectory(s.work, 'low-risk');
  assert.equal(inspection.manifest.admission, 'eligible-after-owner-review');
  const review = await requestReview(s, inspection);
  assert.equal(review.status, 'held');
  assert.equal(existsSync(path.join(s.work, 'skills/low-risk')), false);
  assert.equal((await s.keeper.processPending()).processed, 0, 'owner 未点选前 keeper 不应自动晋升');
});

test('路径与文件类型检查：符号链接父目录/NUL resource 均 fail closed', async () => {
  const s = setup();
  await saveStage(s, 'skills/_incoming/path-safe/SKILL.md', skillDoc('path-safe'));
  const outside = path.join(s.work, '..', 'outside-skill-test');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(s.work, 'skills/_incoming/path-safe/linked'));
  const linked = await saveStage(s, 'skills/_incoming/path-safe/linked/escape.txt', 'nope\n');
  assert.equal(linked.result.held, 1);
  assert.equal(existsSync(path.join(outside, 'escape.txt')), false);
  rmSync(path.join(s.work, 'skills/_incoming/path-safe/linked'));
  const nul = await saveStage(s, 'skills/_incoming/path-safe/references/nul.txt', 'a\0b');
  assert.equal(nul.result.held, 1);
  assert.equal(existsSync(path.join(s.work, 'skills/_incoming/path-safe/references/nul.txt')), false);
  const symlinkRoot = path.join(s.work, 'skills', '_incoming', 'linked-root');
  symlinkSync(outside, symlinkRoot);
  assert.throws(() => inspectSkillDirectory(s.work, 'linked-root'), /SKILL_RESOURCE_UNSAFE|符号链接/,
    '外部 git 变更把整个 staged Skill 换成 symlink 时，inspect 也须 fail closed');
});

test('全 MCP 闭环：save 根文件/资源 → inspect → promote receipt → owner 点选 → 正式目录完整', async () => {
  const { work } = makeInstance();
  const notifications = [];
  const app = createApp({
    instanceDir: work,
    tokens: { 'skill-owner-token': { client: 'owner-agent', trust: 'high', channel: 'primary' } },
    notify: async (text) => { notifications.push(text); return { ok: true }; },
  });
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const client = new Client({ name: 'skill-e2e', version: '0.0.1' });
  const keeper = createKeeper({
    instanceDir: work, writer: app.locals.writer, approvals: app.locals.approvals,
    nativeReg: app.locals.nativeReg,
    provider: { judge: async () => { throw new Error('Skill MCP 闭环不应调用 LLM'); } },
    notifier: { notify: async () => ({ ok: true }) }, doctor: false,
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer skill-owner-token' } },
    }));
    const name = 'mcp-complete-skill';
    const staged = [
      ['SKILL.md', skillDoc(name)],
      ['references/runbook.md', '# Runbook\n\n完整参考资料。\n'],
      ['scripts/check.py', 'print("mcp-ok")\n'],
      ['agents/openai.yaml', 'interface:\n  display_name: MCP complete\n'],
    ];
    for (const [rel, content] of staged) {
      const saved = await client.callTool({
        name: 'save', arguments: { content, hint: `path: skills/_incoming/${name}/${rel}` },
      });
      assert.notEqual(saved.isError, true, `save ${rel} 不应失败：${saved.content?.[0]?.text}`);
      const filed = await keeper.processPending();
      assert.equal(filed.filed, 1, `${rel} 应经 keeper 写入 staging`);
    }

    const inspected = await client.callTool({ name: 'skill_inspect', arguments: { name } });
    assert.notEqual(inspected.isError, true);
    const inspection = JSON.parse(inspected.content[0].text);
    assert.equal(inspection.file_count, 4);
    assert.equal(inspection.manifest.admission, 'manual-audit-required');

    const proposed = await client.callTool({
      name: 'promote_skill',
      arguments: { name, content_id: inspection.content_id, revision: inspection.revision },
    });
    assert.notEqual(proposed.isError, true, proposed.content?.[0]?.text);
    assert.equal(existsSync(path.join(work, 'skills', name)), false, '提交审核本身不得直接晋升');
    const duplicate = await client.callTool({
      name: 'promote_skill',
      arguments: { name, content_id: inspection.content_id, revision: inspection.revision },
    });
    assert.notEqual(duplicate.isError, true);
    assert.equal(notifications.filter((text) => /Skill 待 owner 晋升审核/.test(text)).length, 1,
      '同一 revision 重复请求不得重复通知 owner');

    const listed = await client.callTool({ name: 'inbox_list', arguments: {} });
    const review = JSON.parse(listed.content[0].text).entries.find((e) => e.kind === 'skill');
    assert.ok(review, '主频道应看到一条 Skill 审核件');
    assert.match(review.options[0].label, /批准晋升此版本/);
    assert.match(review.options[1].label, /拒绝晋升/);

    const resolved = await client.callTool({
      name: 'inbox_resolve', arguments: { id: review.id, ruling: '批准这个确切版本', option: 0 },
    });
    assert.notEqual(resolved.isError, true, resolved.content?.[0]?.text);
    assert.equal((await keeper.processPending()).filed, 1);
    assert.equal(existsSync(path.join(work, 'skills', '_incoming', name)), false);
    for (const [rel, content] of staged) {
      const formal = path.join(work, 'skills', name, rel);
      assert.ok(existsSync(formal), `正式目录缺少 ${rel}`);
      const actual = readFileSync(formal, 'utf8');
      if (rel === 'SKILL.md') {
        assert.match(actual, new RegExp(`^---\\ncontent_id: ${inspection.content_id}\\n`), '根文档应保留 staging 时注入的稳定 content_id');
        assert.equal(actual.replace(`content_id: ${inspection.content_id}\n`, ''), content.trim(), '除 content_id 外根文档应完整保留');
      } else {
        assert.equal(actual, content.trim(), `${rel} 内容应完整保留`);
      }
    }
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
