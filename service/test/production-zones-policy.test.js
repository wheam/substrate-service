// 生产实例会把内容区与服务区一起注册进 zones.md；这些回归测试确保“已注册”不会
// 意外把 inbox / keeper-feedback 暴露到知识读面，也不会让普通 keeper plan 写服务区。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndexStore } from '../src/index-store.js';
import { createAdmission } from '../src/inbox.js';
import {
  applyDecisionPlan,
  validateDecision,
  validateDecisionPlan,
} from '../src/executor.js';
import { createTools } from '../src/tools.js';
import { testAuthorizedEntry } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

const PRODUCTION_ZONES = `  - id: skills
    path: skills/
    purpose: skill 分发
    schema: skill-zone-v1
    maintainer_skill: substrate-sync
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: raw
    path: raw/
    purpose: 原始素材只追加存档
    schema: raw-zone-v1
    maintainer_skill: substrate-curator
    readers: [all]
    writers: [all]
    disposition: reference
    privacy: private
  - id: inbox
    path: inbox/
    purpose: 服务写入隔离区
    schema: inbox-zone-v1
    maintainer_skill: keeper
    readers: [all]
    writers: [service]
    disposition: canonical
    privacy: private
  - id: keeper-feedback
    path: keeper-feedback/
    purpose: keeper 主人裁定判例
    schema: keeper-feedback-zone-v1
    maintainer_skill: keeper
    readers: [all]
    writers: [service]
    disposition: canonical
    privacy: private
  - id: health
    path: health/
    purpose: 主人的长期个人健康档案
    schema: health-zone-v1
    maintainer_skill: substrate-curator
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: sensitive
`;

function productionInstance(tag) {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-production-zones-${tag}-`));
  const instanceDir = path.join(base, 'instance');
  cpSync(fixtureDir, instanceDir, { recursive: true });
  const zonesPath = path.join(instanceDir, 'governance', 'zones.md');
  const zones = readFileSync(zonesPath, 'utf8');
  assert.match(zones, /\n```\s*$/, 'fixture zones.md 必须以 yaml fence 闭合');
  writeFileSync(zonesPath, zones.replace(/\n```\s*$/, `\n${PRODUCTION_ZONES}\`\`\`\n`));
  for (const dir of ['health', 'raw', 'inbox', 'keeper-feedback']) {
    mkdirSync(path.join(instanceDir, dir), { recursive: true });
  }
  return { base, instanceDir, indexPath: path.join(base, 'index.sqlite') };
}

function admissionEntry({ id, body, admission, kind = 'save' }) {
  return testAuthorizedEntry({
    id,
    kind,
    client: 'production-policy-test',
    body,
    admission,
  }, admission.capabilities);
}

function highSaveEntry(id, body = `通用测试正文 ${id}`) {
  const admission = createAdmission({
    identity: { trust: 'high', source: 'test', channel: 'primary' },
    ingress: 'save',
    kind: 'save',
  });
  return admissionEntry({ id, body, admission });
}

function pageDecision({ zone, action = 'new_page', target }) {
  return {
    disposition: 'canonical',
    tier: 'canonical',
    zone,
    action,
    target,
    title: '生产 zone 策略测试',
    page_type: 'observation',
    summary: '验证通用 keeper zone 策略',
    confidence: 0.97,
  };
}

test('生产式注册不解封服务区：inbox/keeper-feedback 不可 search、read 或进入索引；skills 高信任仍可读', async () => {
  const { instanceDir, indexPath } = productionInstance('read-boundary');
  const isolated = [
    {
      zone: 'inbox',
      rel: 'inbox/_pending.md',
      probe: 'registeredinboxpendingprobe',
      raw: '---\nid: pending-probe\ntype: inbox\nstatus: pending\n---\n\nregisteredinboxpendingprobe 待 keeper 判定。\n',
    },
    {
      zone: 'inbox',
      rel: 'inbox/_held.md',
      probe: 'registeredinboxheldprobe',
      raw: '---\nid: held-probe\ntype: inbox\ntier: candidate\nstatus: held\n---\n\nregisteredinboxheldprobe 待主人裁定。\n',
    },
    {
      zone: 'keeper-feedback',
      rel: 'keeper-feedback/_cases.md',
      probe: 'registeredkeeperfeedbackprobe',
      raw: '# keeper cases\n\nregisteredkeeperfeedbackprobe 主人裁定内情。\n',
    },
  ];
  for (const item of isolated) writeFileSync(path.join(instanceDir, item.rel), item.raw);
  const skillRel = 'skills/registered-readable-probe.txt';
  writeFileSync(path.join(instanceDir, skillRel), 'registered skill read probe\n');

  const tools = createTools({ instanceDir });
  for (const item of isolated) {
    for (const query of [
      { query: item.probe, trust: 'high', include: 'candidate,rejected' },
      { query: item.probe, zone: item.zone, trust: 'high', include: 'candidate,rejected' },
    ]) {
      assert.equal((await tools.search(query)).results.length, 0,
        `${item.rel} 即使注册且显式指定 zone，也不得进入 search`);
    }
    await assert.rejects(
      () => tools.readPage({ path: item.rel, trust: 'high' }),
      /服务|治理|拒绝/,
      `${item.rel} 即使高信任也不经通用 read_page 暴露`,
    );
  }
  const skill = await tools.readPage({ path: skillRel, trust: 'high' });
  assert.equal(skill.content, 'registered skill read probe\n', 'skills 是注册内容区，不应被服务区隔离规则误伤');

  const store = createIndexStore({ instanceDir, indexPath });
  try {
    store.rebuild();
    const db = new DatabaseSync(indexPath);
    try {
      const count = db.prepare(`SELECT count(*) AS n FROM docs WHERE path IN (${isolated.map(() => '?').join(',')})`)
        .get(...isolated.map((item) => item.rel)).n;
      assert.equal(count, 0, 'pending/held inbox 与 keeper-feedback 必须在建索引阶段就被排除，不能只靠查询 ACL 隐藏');
    } finally { db.close(); }
  } finally { store.close(); }
});

test('health(sensitive)：high save 可通用新建；缺 sensitive capability 的直接校验与 plan 均拒绝', async () => {
  const { instanceDir } = productionInstance('health-write');
  const allowedEntry = highSaveEntry(
    'health-high-save',
    '2026-08-06：昨夜睡眠 7 小时 20 分钟，今晨主观精力良好。',
  );
  const allowedDecision = pageDecision({
    zone: 'health',
    target: 'sleep-observation-2026-08-06',
  });
  const allowed = validateDecisionPlan({ instanceDir, entry: allowedEntry, decision: allowedDecision });
  assert.equal(allowed.ok, true, allowed.reason);
  await applyDecisionPlan({ instanceDir, entry: allowedEntry, decision: allowedDecision, validation: allowed });
  const healthPage = path.join(instanceDir, 'health', 'sleep-observation-2026-08-06.md');
  assert.ok(existsSync(healthPage), '通用 high save 应能在 sensitive health 新建普通观测页');
  assert.match(readFileSync(healthPage, 'utf8'), /睡眠 7 小时 20 分钟/);

  const captureAdmission = createAdmission({
    identity: { trust: 'capture', source: 'app-ios', channel: 'capture' },
    ingress: 'capture',
    kind: 'capture',
  });
  const deniedEntry = admissionEntry({
    id: 'health-without-sensitive-cap',
    kind: 'capture',
    body: '一条没有敏感区写能力的普通观测。',
    admission: captureAdmission,
  });
  const deniedDecision = pageDecision({ zone: 'health', target: 'unauthorized-health-observation' });
  for (const checked of [
    validateDecision({ instanceDir, entry: deniedEntry, decision: { ...deniedDecision } }),
    validateDecisionPlan({ instanceDir, entry: deniedEntry, decision: { ...deniedDecision } }),
  ]) {
    assert.equal(checked.ok, false);
    assert.equal(checked.holdClass, 'security');
    assert.match(checked.reason, /zone:sensitive-write/);
  }
  assert.ok(!existsSync(path.join(instanceDir, 'health', 'unauthorized-health-observation.md')),
    '缺 sensitive capability 的 plan 不得产生页面');
});

test('raw 是 append-only 存档区：merge_into 拒绝，new_page 允许', async () => {
  const { instanceDir } = productionInstance('raw-write');
  writeFileSync(path.join(instanceDir, 'raw', 'existing-source.md'), '# 原始素材\n\n不可原位修改。\n');
  const submitted = highSaveEntry('raw-policy');

  const merge = validateDecisionPlan({
    instanceDir,
    entry: submitted,
    decision: pageDecision({ zone: 'raw', action: 'merge_into', target: 'existing-source' }),
  });
  assert.equal(merge.ok, false);
  assert.equal(merge.holdClass, 'security');
  assert.match(merge.reason, /raw.*只允许新建|只允许新建.*raw/i);

  const createDecision = pageDecision({ zone: 'raw', target: 'new-source-archive' });
  const create = validateDecisionPlan({ instanceDir, entry: submitted, decision: createDecision });
  assert.equal(create.ok, true, create.reason);
  await applyDecisionPlan({ instanceDir, entry: submitted, decision: createDecision, validation: create });
  assert.ok(existsSync(path.join(instanceDir, 'raw', 'new-source-archive.md')));
});

test('普通 keeper plan 不能向 writers:[service] 的注册 zone 新建或合并', () => {
  const { instanceDir } = productionInstance('service-write');
  for (const zone of ['inbox', 'keeper-feedback']) {
    writeFileSync(path.join(instanceDir, zone, 'existing.md'), `# ${zone}\n\n服务维护内容。\n`);
  }
  const submitted = highSaveEntry('ordinary-plan-service-zone');
  for (const zone of ['inbox', 'keeper-feedback']) {
    for (const [action, target] of [['new_page', 'ordinary-new'], ['merge_into', 'existing']]) {
      const checked = validateDecisionPlan({
        instanceDir,
        entry: submitted,
        decision: pageDecision({ zone, action, target }),
      });
      assert.equal(checked.ok, false, `${action} 不得写 ${zone}`);
      assert.equal(checked.holdClass, 'security');
      assert.match(checked.reason, /服务区.*不接受普通 keeper 内容写入/);
    }
  }
});
