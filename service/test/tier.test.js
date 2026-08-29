// M4.2 分层原语 + 写路径校验 + backfill --tier（spec §3.1 / §6.1 / §6.2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readTier, normTier, hasExplicitTier, setTierLine, normalizeInclude,
  DEFAULT_TIER, TIER_RANK,
} from '../src/tier.js';
import { validateDecision } from '../src/executor.js';
import { backfill } from '../scripts/backfill-content-id.js';
import { testAuthorizedEntry } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
function tmpInstance(tag) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`)), 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

// ==== 原语 ====

test('readTier / normTier：无 tier 视同 canonical；只认首个 frontmatter 块', () => {
  assert.equal(readTier('---\ntitle: t\n---\n\n正文\n'), 'canonical', '无 tier → canonical（迁移铁律）');
  assert.equal(readTier('---\ntier: candidate\ntitle: t\n---\n\nx\n'), 'candidate');
  assert.equal(readTier('---\ntier: rejected\n---\n\nx\n'), 'rejected');
  // 正文里的 tier: 字样不算
  assert.equal(readTier('---\ntitle: t\n---\n\ntier: candidate 只是正文\n'), 'canonical');
  // 非法值归一到 canonical（读侧宽容）
  assert.equal(readTier('---\ntier: bogus\n---\n\nx\n'), 'canonical');
  assert.equal(normTier(undefined), DEFAULT_TIER);
  assert.equal(normTier('candidate'), 'candidate');
  assert.equal(normTier('rejected'), 'rejected');
  assert.equal(normTier('nope'), 'canonical');
  assert.ok(TIER_RANK.canonical > TIER_RANK.candidate && TIER_RANK.candidate > TIER_RANK.rejected);
});

test('缺陷4：readTier/normTier 按 YAML 标量归一——去引号、trim、lowercase（写法变体同解）', () => {
  assert.equal(readTier('---\ntier: "candidate"\n---\n\nx\n'), 'candidate', '双引号');
  assert.equal(readTier("---\ntier: 'candidate'\n---\n\nx\n"), 'candidate', '单引号');
  assert.equal(readTier('---\ntier: CANDIDATE\n---\n\nx\n'), 'candidate', '大写');
  assert.equal(readTier('---\ntier:    candidate   \n---\n\nx\n'), 'candidate', '多空格');
  assert.equal(readTier('---\ntier: "REJECTED"\n---\n\nx\n'), 'rejected', '引号+大写 rejected');
  assert.equal(normTier('"candidate"'), 'candidate');
  assert.equal(normTier(" 'Rejected' "), 'rejected');
  assert.equal(normTier('Canonical'), 'canonical');
});

test('hasExplicitTier / setTierLine：块内 upsert，正文不误伤', () => {
  const noTier = '---\ncontent_id: abcd1234\ntitle: t\n---\n\n正文 tier: x\n';
  assert.equal(hasExplicitTier(noTier), false);
  const added = setTierLine(noTier, 'candidate');
  assert.equal(hasExplicitTier(added), true);
  assert.equal(readTier(added), 'candidate');
  assert.match(added, /content_id: abcd1234\ntier: candidate\n/, 'tier 插在 content_id 之后');
  assert.match(added, /正文 tier: x/, '正文不受影响');
  // 已有 tier → 替换
  const replaced = setTierLine(added, 'canonical');
  assert.equal(readTier(replaced), 'canonical');
  assert.ok(!/tier: candidate/.test(replaced.match(/^---\n[\s\S]*?\n---/)[0]));
  // 无 content_id → 插块首
  const bare = setTierLine('---\ntitle: t\n---\n\nx\n', 'rejected');
  assert.match(bare, /^---\ntier: rejected\ntitle: t/);
  // 无 frontmatter → 原样返回
  assert.equal(setTierLine('纯文本', 'canonical'), '纯文本');
});

test('normalizeInclude：数组/逗号串，去重、只留合法附加档（canonical 不在其列）', () => {
  assert.deepEqual(normalizeInclude(undefined), []);
  assert.deepEqual(normalizeInclude('candidate'), ['candidate']);
  assert.deepEqual(normalizeInclude('candidate,rejected'), ['candidate', 'rejected']);
  assert.deepEqual(normalizeInclude('staging,candidate'), ['staging', 'candidate']);
  assert.deepEqual(normalizeInclude(' rejected , candidate '), ['rejected', 'candidate']);
  assert.deepEqual(normalizeInclude(['candidate', 'candidate']), ['candidate'], '去重');
  assert.deepEqual(normalizeInclude('canonical,bogus'), [], 'canonical/非法值不作为附加档');
});

// ==== 写路径校验：validateDecision 拒非法 tier（spec §6.1 白名单）====

test('validateDecision：tier 白名单——canonical/candidate/缺省过；rejected/非法拒', () => {
  const dir = tmpInstance('validate-tier');
  const base = { disposition: 'canonical', zone: 'knowledge', action: 'new_page', target: 'x', summary: 's', confidence: 0.9 };
  const entry = testAuthorizedEntry();
  assert.equal(validateDecision({ instanceDir: dir, decision: { ...base }, entry }).ok, true, '缺省 tier → 视同 canonical，过');
  assert.equal(validateDecision({ instanceDir: dir, decision: { ...base, tier: 'canonical' }, entry }).ok, true);
  assert.equal(validateDecision({ instanceDir: dir, decision: { ...base, tier: 'candidate' }, entry }).ok, true);
  const rej = validateDecision({ instanceDir: dir, decision: { ...base, tier: 'rejected' }, entry });
  assert.equal(rej.ok, false, 'rejected 不是模型可产出的 tier（只能由 keeper 判 forbidden 后代码落）');
  assert.match(rej.reason, /tier/);
  const bad = validateDecision({ instanceDir: dir, decision: { ...base, tier: 'admin' }, entry });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /tier/);
});

test('缺陷3：validateDecision 对无 tier 落点的 action 把 candidate 归一 canonical（new_page/merge_into 保留）', () => {
  const dir = tmpInstance('validate-tier-norm');
  const base = { disposition: 'canonical', tier: 'candidate', summary: 's', confidence: 0.9 };
  const entry = testAuthorizedEntry();
  // new_page / merge_into：能落 tier → 保留 candidate
  const np = { ...base, zone: 'knowledge', action: 'new_page', target: 'x' };
  assert.equal(validateDecision({ instanceDir: dir, decision: np, entry }).ok, true);
  assert.equal(np.tier, 'candidate', 'new_page 保留 candidate');
  const mi = { ...base, zone: 'knowledge', action: 'merge_into', target: 'coffee-brewing' };
  assert.equal(validateDecision({ instanceDir: dir, decision: mi, entry }).ok, true);
  assert.equal(mi.tier, 'candidate', 'merge_into 保留 candidate');
  // upsert_row / todo_add：无 tier 落点 → 归一 canonical（就地改写，令审计不说谎）
  const ur = { ...base, zone: 'collections', action: 'upsert_row', target: 'restaurants', fields: { name: 'x' } };
  assert.equal(validateDecision({ instanceDir: dir, decision: ur, entry }).ok, true);
  assert.equal(ur.tier, 'canonical', 'upsert_row 无 tier 落点 → 归一 canonical');
  const ta = { ...base, zone: 'todo', action: 'todo_add', target: 'owner' };
  assert.equal(validateDecision({ instanceDir: dir, decision: ta, entry: { ...entry, kind: 'todo' } }).ok, true);
  assert.equal(ta.tier, 'canonical', 'todo_add 无 tier 落点 → 归一 canonical');
});

// ==== 迁移：backfill --tier（可选、幂等、只增不改）====

test('backfill --tier：给无显式 tier 的存量页补 canonical，幂等；不带 tier 则完全不碰', () => {
  const dir = tmpInstance('backfill-tier');
  // 不带 tier：现有页仍无 tier
  const r0 = backfill(dir, { apply: true });
  assert.deepEqual(r0.tiered ?? [], [], '未传 tier → 不标注');
  const coffee = path.join(dir, 'knowledge', 'coffee-brewing.md');
  assert.equal(hasExplicitTier(readFileSync(coffee, 'utf8')), false);
  // 带 tier=canonical：补显式 tier
  const r1 = backfill(dir, { apply: true, tier: 'canonical' });
  assert.ok(r1.tiered.length >= 1, '至少给一页补 tier');
  assert.equal(readTier(readFileSync(coffee, 'utf8')), 'canonical');
  // 幂等：第二遍零标注
  const r2 = backfill(dir, { apply: true, tier: 'canonical' });
  assert.equal(r2.tiered.length, 0, '已有显式 tier → 不覆盖（幂等）');
});

test('缺陷5：backfill --tier 只接受缺省或 canonical；candidate/rejected/非法值直接报错、不写盘', () => {
  const dir = tmpInstance('backfill-guard');
  for (const bad of ['rejected', 'candidate', 'bogus', '"candidate"', 'REJECTED']) {
    assert.throws(() => backfill(dir, { apply: true, tier: bad }), /canonical/, `--tier=${bad} 应报错拒绝`);
  }
  // 报错发生在写盘之前：coffee-brewing.md 仍无显式 tier
  assert.equal(hasExplicitTier(readFileSync(path.join(dir, 'knowledge', 'coffee-brewing.md'), 'utf8')), false,
    '拒绝的 --tier 不得写盘');
  // 缺省与 canonical 仍可用
  assert.doesNotThrow(() => backfill(dir, { apply: false }));
  assert.doesNotThrow(() => backfill(dir, { apply: false, tier: 'canonical' }));
  assert.doesNotThrow(() => backfill(dir, { apply: false, tier: '"canonical"' }), '带引号的 canonical 归一后放行');
});
