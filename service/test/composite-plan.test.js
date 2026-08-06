// 有界复合计划 v1：一份收件正文只归档一次，并在同区已有普通页追加确定性引用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyDecisionPlan, validateDecisionPlan } from '../src/executor.js';
import { testAuthorizedEntry } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function tmpInstance(tag) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), `substrate-composite-${tag}-`)), 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function entry(id, capabilities = ['page:create', 'page:append']) {
  return testAuthorizedEntry({
    id,
    kind: 'save',
    client: 'cc-test',
    body: `复合计划正文 ${id}`,
  }, capabilities);
}

function decision({
  zone = 'knowledge',
  source = 'composite-note',
  target = 'coffee-brewing',
  primary = {},
  reference = {},
  extraOperations = [],
} = {}) {
  const first = {
    action: 'new_page',
    zone,
    target: source,
    content_source: 'entry_body',
    title: '复合计划观测',
    page_type: 'observation',
    links: [],
    ...primary,
  };
  const second = {
    action: 'append_reference',
    zone,
    target,
    source_operation: 0,
    ...reference,
  };
  return {
    disposition: 'canonical',
    tier: 'canonical',
    zone: first.zone,
    action: first.action,
    target: first.target,
    summary: '归档正文并在同区索引页追加引用',
    confidence: 0.97,
    epistemic_type: 'fact',
    operations: [first, second, ...extraOperations],
  };
}

function snapshotTree(root) {
  const snapshot = [];
  function walk(abs, rel = '') {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? path.posix.join(rel, name) : name;
      if (statSync(childAbs).isDirectory()) {
        snapshot.push(`dir:${childRel}`);
        walk(childAbs, childRel);
      } else {
        snapshot.push(`file:${childRel}:${readFileSync(childAbs).toString('base64')}`);
      }
    }
  }
  walk(root);
  return snapshot;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('普通 zone：new_page + append_reference 校验并执行成功', async () => {
  const instanceDir = tmpInstance('ordinary');
  const submitted = entry('ordinary-1');
  const planned = decision({ source: 'ordinary-observation' });

  const validation = validateDecisionPlan({ instanceDir, decision: planned, entry: submitted });
  assert.equal(validation.ok, true);
  assert.equal(validation.plan.sourceRel, 'knowledge/ordinary-observation.md');
  assert.equal(validation.plan.targetRel, 'knowledge/coffee-brewing.md');

  const result = await applyDecisionPlan({ instanceDir, decision: planned, entry: submitted, validation });
  const source = readFileSync(path.join(instanceDir, validation.plan.sourceRel), 'utf8');
  const target = readFileSync(path.join(instanceDir, validation.plan.targetRel), 'utf8');
  assert.match(source, /复合计划正文 ordinary-1/, '新页正文必须来自 entry.body');
  assert.equal(occurrences(target, '[[ordinary-observation]]'), 1, '目标页只追加一条确定性引用');
  assert.ok(result.changedPaths.includes(validation.plan.sourceRel));
  assert.ok(result.changedPaths.includes(validation.plan.targetRel));
});

test('sensitive zone：缺 zone:sensitive-write 拒绝，具备 capability 后成功', async () => {
  const deniedDir = tmpInstance('sensitive-denied');
  const deniedEntry = entry('sensitive-denied-1');
  const deniedPlan = decision({
    zone: 'memory',
    source: 'sensitive-observation',
    target: 'core-summary',
  });
  const before = snapshotTree(deniedDir);
  const denied = validateDecisionPlan({ instanceDir: deniedDir, decision: deniedPlan, entry: deniedEntry });
  assert.equal(denied.ok, false);
  assert.equal(denied.holdClass, 'security');
  assert.match(denied.reason, /zone:sensitive-write/);
  await assert.rejects(
    () => applyDecisionPlan({ instanceDir: deniedDir, decision: deniedPlan, entry: deniedEntry, validation: denied }),
    /zone:sensitive-write/,
  );
  assert.deepEqual(snapshotTree(deniedDir), before, '缺敏感区 capability 时不得产生任何落盘副作用');

  const allowedDir = tmpInstance('sensitive-allowed');
  const allowedEntry = entry('sensitive-allowed-1', ['page:create', 'page:append', 'zone:sensitive-write']);
  const allowedPlan = decision({
    zone: 'memory',
    source: 'sensitive-observation',
    target: 'core-summary',
  });
  const allowed = validateDecisionPlan({ instanceDir: allowedDir, decision: allowedPlan, entry: allowedEntry });
  assert.equal(allowed.ok, true);
  await applyDecisionPlan({ instanceDir: allowedDir, decision: allowedPlan, entry: allowedEntry, validation: allowed });
  assert.match(readFileSync(path.join(allowedDir, allowed.plan.sourceRel), 'utf8'), /sensitive-allowed-1/);
  assert.match(readFileSync(path.join(allowedDir, allowed.plan.targetRel), 'utf8'), /\[\[sensitive-observation\]\]/);
});

test('越界复合计划均拒绝，且 apply 不产生副作用', async (t) => {
  const cases = [
    {
      name: '跨 zone',
      build: () => decision({ reference: { zone: 'memory', target: 'core-summary' } }),
      reason: /跨 zone/,
    },
    {
      name: '第三步',
      build: () => decision({
        extraOperations: [{ action: 'append_reference', zone: 'knowledge', target: 'coffee-brewing', source_operation: 0 }],
      }),
      reason: /恰好 2 步/,
    },
    {
      name: '第二步自带 body',
      build: () => decision({ reference: { body: '模型私带正文' } }),
      reason: /非白名单字段/,
    },
    {
      name: '第二步自带 patch',
      build: () => decision({ reference: { patch: { op: 'replace' } } }),
      reason: /非白名单字段/,
    },
    {
      name: '结构页',
      build: () => decision({ target: 'ops/README' }),
      reason: /结构页/,
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const instanceDir = tmpInstance(`reject-${c.name}`);
      const submitted = entry(`reject-${c.name}`);
      const planned = c.build();
      const before = snapshotTree(instanceDir);
      const validation = validateDecisionPlan({ instanceDir, decision: planned, entry: submitted });
      assert.equal(validation.ok, false);
      assert.match(validation.reason, c.reason);
      await assert.rejects(
        () => applyDecisionPlan({ instanceDir, decision: planned, entry: submitted, validation }),
        c.reason,
      );
      assert.deepEqual(snapshotTree(instanceDir), before, `${c.name} 被拒后不得改动实例`);
    });
  }
});

test('目标页已有同一引用时 append_reference 幂等', async () => {
  const instanceDir = tmpInstance('idempotent');
  const targetAbs = path.join(instanceDir, 'knowledge', 'coffee-brewing.md');
  const seededTarget = `${readFileSync(targetAbs, 'utf8').replace(/\s*$/, '')}\n\n- [[idempotent-source]]\n`;
  writeFileSync(targetAbs, seededTarget);
  const submitted = entry('idempotent-1');
  const planned = decision({ source: 'idempotent-source' });
  const validation = validateDecisionPlan({ instanceDir, decision: planned, entry: submitted });
  assert.equal(validation.ok, true);

  const result = await applyDecisionPlan({ instanceDir, decision: planned, entry: submitted, validation });
  assert.equal(readFileSync(targetAbs, 'utf8'), seededTarget, '已有引用的目标页不应被重写');
  assert.equal(occurrences(seededTarget, '[[idempotent-source]]'), 1);
  assert.match(result.detail, /幂等/);
  assert.ok(!result.changedPaths.includes('knowledge/coffee-brewing.md'));
});

test('validate 后目标页 hash 变化，apply 拒绝过期计划且不追加引用', async () => {
  const instanceDir = tmpInstance('target-race');
  const submitted = entry('target-race-1');
  const planned = decision({ source: 'race-source' });
  const validation = validateDecisionPlan({ instanceDir, decision: planned, entry: submitted });
  assert.equal(validation.ok, true);

  const targetAbs = path.join(instanceDir, validation.plan.targetRel);
  const concurrent = `${readFileSync(targetAbs, 'utf8').replace(/\s*$/, '')}\n\n并发写入。\n`;
  writeFileSync(targetAbs, concurrent);

  await assert.rejects(
    () => applyDecisionPlan({ instanceDir, decision: planned, entry: submitted, validation }),
    /目标在计划后已变化/,
  );
  const target = readFileSync(targetAbs, 'utf8');
  assert.equal(target, concurrent, '拒绝过期计划时不得覆盖并发修改');
  assert.ok(!target.includes('[[race-source]]'), '过期计划不得向目标页追加引用');
});
