// recall 证据覆盖评测（离线，脱敏 fixture）。跑法：npm run eval:recall（或 node --test test/recall-eval.test.js）。
//
// 边界（重要）：本文件只验收【服务端给出的证据】——金标规则片段在不在证据里、该空的是不是真空、
// 低信任会不会串到敏感页。它【不】验收宿主选没选对工具，也【不】验收模型答得对不对：
// 那两项要在真实宿主 + 真实模型上另做，见 docs/08-knowledge-usability.md。
// 本文件不接任何真实云 API，也不用假 provider 的输出当作模型行为的证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexStore } from '../src/index-store.js';
import {
  loadQuestions, runEvidenceEval, formatEvalReport, scoreQuestion, DEFAULT_EVAL_THRESHOLD,
} from '../src/recall-eval.js';

const evalFixture = fileURLToPath(new URL('./fixture/eval-instance', import.meta.url));
const questionPath = fileURLToPath(new URL('./goldens/recall-questions.jsonl', import.meta.url));

function evalInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-recall-eval-'));
  const dir = path.join(base, 'instance');
  cpSync(evalFixture, dir, { recursive: true });
  return { dir, indexPath: path.join(base, 'idx.sqlite') };
}

test('问句集本身合法：约 20 条、覆盖显式/隐式/纠正/负例/不存在/ACL 六类，且标注齐全', () => {
  const questions = loadQuestions(questionPath);
  assert.ok(questions.length >= 20, `问句应不少于 20 条（当前 ${questions.length}）`);
  const cats = new Set(questions.map((q) => q.category));
  for (const c of ['explicit', 'implicit', 'correction', 'negative', 'missing', 'acl']) {
    assert.ok(cats.has(c), `缺类别：${c}`);
  }
  const ids = questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
  for (const q of questions) {
    if (q.expect === 'evidence') {
      assert.ok((q.gold?.length ?? 0) + (q.gold_paths?.length ?? 0) > 0, `${q.id} 应给出金标`);
    }
    assert.ok(Array.isArray(q.expect_tools), `${q.id} 应标注期望调用的工具（供真模型验收）`);
    assert.ok(Array.isArray(q.forbidden_conclusions), `${q.id} 应标注不得出现的结论（供真模型验收）`);
  }
});

test('证据覆盖评测：真实检索管线在脱敏 fixture 上达到门槛', () => {
  const { dir, indexPath } = evalInstance();
  const indexStore = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const report = runEvidenceEval({ questions: loadQuestions(questionPath), indexStore, instanceDir: dir });
    assert.ok(
      report.rate >= DEFAULT_EVAL_THRESHOLD,
      `证据覆盖率 ${report.passed}/${report.total} 低于门槛：\n${formatEvalReport(report)}`,
    );
  } finally { indexStore.close(); }
});

test('报告如实划清边界：不把工具选择/结论正确性算进通过率', () => {
  const { dir, indexPath } = evalInstance();
  const indexStore = createIndexStore({ instanceDir: dir, indexPath });
  try {
    const report = runEvidenceEval({ questions: loadQuestions(questionPath), indexStore, instanceDir: dir });
    const text = formatEvalReport(report);
    assert.match(text, /只覆盖【服务端证据】/);
    assert.match(text, /本 runner 不判分/);
    assert.match(text, /真实宿主 \+ 真实模型/);
    for (const r of report.results) {
      assert.ok(r.host_only, '每条结果都应保留 host_only 标注');
    }
    // 已知缺口条目不进门槛，但必须在报告里点名——否则它会变成一个悄悄消失的问题
    assert.ok(report.knownGaps.length >= 1, 'fixture 里应保留已知缺口条目做退化监控');
    assert.match(text, /已知缺口（本批不修，只做退化监控）/);
    for (const g of report.knownGaps) {
      assert.ok(text.includes(g.id), `报告应点名已知缺口 ${g.id}`);
      assert.ok(g.gap_note, `${g.id} 应说明缺口是什么`);
      assert.ok(!report.failures.some((f) => f.id === g.id), '已知缺口不得混进门槛失败列表');
    }
  } finally { indexStore.close(); }
});

// 判分逻辑本身要能抓错——否则评测只会永远绿。用合成 outcome 直接测 scoreQuestion。
test('判分逻辑自测：漏金标、串页、该空不空、越权内容都必须判失败', () => {
  const outcome = (pages, extra = {}) => ({
    pages, candidates: pages, used: 0, truncated: false, dropped: [], budget: 0, ...extra,
  });
  const page = (p, text) => ({ path: p, content_id: null, zone: 'knowledge', truncated: false, blocks: [{ heading: null, lines: '1-1', text }] });

  const missGold = scoreQuestion(
    { id: 'a', expect: 'evidence', gold: ['免费取消'], gold_paths: ['knowledge/hotel-rules.md'] },
    outcome([page('knowledge/hotel-rules.md', '每晚预算上限 1200 元')]),
  );
  assert.equal(missGold.ok, false);
  assert.ok(missGold.violations.some((v) => /缺金标片段/.test(v)));

  const missPage = scoreQuestion(
    { id: 'b', expect: 'evidence', gold: [], gold_paths: ['knowledge/hotel-rules.md'] },
    outcome([page('knowledge/other.md', 'x')]),
  );
  assert.equal(missPage.ok, false);
  assert.ok(missPage.violations.some((v) => /未覆盖金标页/.test(v)));

  const shouldBeEmpty = scoreQuestion(
    { id: 'c', expect: 'no-evidence' },
    outcome([page('knowledge/hotel-rules.md', 'x')]),
  );
  assert.equal(shouldBeEmpty.ok, false);
  assert.ok(shouldBeEmpty.violations.some((v) => /本该零证据/.test(v)));

  const leaked = scoreQuestion(
    { id: 'd', expect: 'evidence', gold: ['x'], must_not: ['小林'], must_not_paths: ['memory/about-owner/core-summary.md'] },
    outcome([page('memory/about-owner/core-summary.md', 'x 叫我小林就行')]),
  );
  assert.equal(leaked.ok, false);
  assert.equal(leaked.violations.length, 2, '越权内容与越权页应各记一条');

  const good = scoreQuestion(
    { id: 'e', expect: 'evidence', gold: ['免费取消'], gold_paths: ['knowledge/hotel-rules.md'] },
    outcome([page('knowledge/hotel-rules.md', '必须可免费取消')]),
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.violations, []);
});
