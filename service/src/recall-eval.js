// recall-eval.js —— 离线【证据覆盖】评测 runner（知识库易用性首批）。
//
// 它测什么：给一组真实问句，走【产线的检索 + 证据扩展管线】（recall.gatherEvidence），
// 断言服务端实际给出的证据里有没有金标规则、有没有越权/串页、该空的时候是不是真的空。
//
// 它【不】测什么，也永远不该被当成它测过（这是本文件存在的最大风险）：
//   · 宿主到底有没有调工具、调了哪个工具 —— 只有客户端会话轨迹能看见，本 runner 拿不到；
//   · 模型最终答得对不对、有没有遵守硬约束、有没有说出被禁的结论 —— 需要真模型 + 人工标注。
// 因此金标里的 expect_tools / forbidden_conclusions 一律【只随报告带出、不判分】。
// 假 provider 的输出不是宿主模型行为的证据；本 runner 干脆不调用任何 provider。
import { readFileSync } from 'node:fs';
import { gatherEvidence } from './recall.js';

// 证据覆盖是确定性的（同一 fixture + 同一检索代码 → 同一结果），所以门槛就是「全过」。
// 要下调阈值必须是明确的决定，并在报告里写清哪条退化了。
export const DEFAULT_EVAL_THRESHOLD = 1;

export function loadQuestions(filePath) {
  return readFileSync(filePath, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l, i) => {
      let q;
      try { q = JSON.parse(l); }
      catch (e) { throw new Error(`问句集第 ${i + 1} 条不是合法 JSON：${e.message}`); }
      if (!q.id || !q.question || !q.expect) throw new Error(`问句 ${q.id ?? i + 1} 缺 id/question/expect`);
      if (!['evidence', 'no-evidence'].includes(q.expect)) throw new Error(`问句 ${q.id} 的 expect 非法：${q.expect}`);
      return q;
    });
}

// 判一条：只判离线能判的东西，判不了的原样返回到 host_only。
export function scoreQuestion(q, outcome) {
  const evidenceText = outcome.pages.flatMap((p) => p.blocks.map((b) => b.text)).join('\n');
  const paths = outcome.pages.map((p) => p.path);
  const violations = [];

  if (q.expect === 'no-evidence') {
    if (outcome.pages.length) violations.push(`本该零证据，却给出了 ${paths.join('、')}`);
  } else {
    if (!outcome.pages.length) violations.push('未给出任何可引用证据');
    for (const g of q.gold ?? []) {
      if (!evidenceText.includes(g)) violations.push(`证据里缺金标片段「${g}」`);
    }
    for (const p of q.gold_paths ?? []) {
      if (!paths.includes(p)) violations.push(`证据未覆盖金标页 ${p}`);
    }
  }
  for (const bad of q.must_not ?? []) {
    if (evidenceText.includes(bad)) violations.push(`证据里出现了不允许的内容「${bad}」`);
  }
  for (const p of q.must_not_paths ?? []) {
    if (paths.includes(p)) violations.push(`证据里出现了不允许的页 ${p}`);
  }

  return {
    id: q.id,
    category: q.category ?? 'uncategorized',
    trust: q.trust ?? 'low',
    question: q.question,
    ok: violations.length === 0,
    // known_gap：已知的、本批【不修】的检索缺口（如词法召回被功能词带偏）。仍然逐条判、逐条报，
    // 只是不计入通过率门槛——把它藏起来会让评测变成自我安慰，把它算进门槛又会逼人为过线而乱改检索。
    known_gap: !!q.known_gap,
    gap_note: q.gap_note ?? null,
    violations,
    paths,
    candidate_count: outcome.candidates.length,
    evidence_chars: outcome.used,
    truncated: outcome.truncated,
    // 离线判不了、必须留给真宿主 + 真模型 + 人工标注的部分：
    host_only: {
      expect_tools: q.expect_tools ?? [],
      forbidden_conclusions: q.forbidden_conclusions ?? [],
    },
  };
}

/**
 * 跑一遍证据覆盖评测。
 * run: (q) => outcome —— 默认用产线管线；注入自定义 run 只用于测 runner 自身的判分逻辑。
 */
export function runEvidenceEval({ questions, indexStore, instanceDir, budget, run } = {}) {
  const exec = run ?? ((q) => gatherEvidence({
    indexStore, instanceDir, query: q.question, trust: q.trust ?? 'low', ...(budget ? { budget } : {}),
  }));
  const results = questions.map((q) => scoreQuestion(q, exec(q)));
  const gated = results.filter((r) => !r.known_gap);
  const passed = gated.filter((r) => r.ok).length;
  const byCategory = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { total: 0, passed: 0, known_gap: 0 });
    c.total++;
    if (r.known_gap) c.known_gap++;
    if (r.ok) c.passed++;
  }
  return {
    results,
    total: gated.length,
    passed,
    rate: gated.length ? passed / gated.length : 0,
    byCategory,
    failures: gated.filter((r) => !r.ok),
    knownGaps: results.filter((r) => r.known_gap),
  };
}

export function formatEvalReport(report, { threshold = DEFAULT_EVAL_THRESHOLD } = {}) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    '# recall 证据覆盖评测（离线，脱敏 fixture）',
    '',
    `通过 ${report.passed}/${report.total}（${pct(report.rate)}），门槛 ${pct(threshold)}`,
    `（分母不含 ${report.knownGaps.length} 条已知缺口条目——它们照常判、照常报，只是不进门槛）`,
    '',
    '按类别：',
    ...Object.entries(report.byCategory).map(([c, v]) =>
      `  - ${c}: ${v.passed}/${v.total}${v.known_gap ? `（含 ${v.known_gap} 条已知缺口）` : ''}`),
    '',
  ];
  if (report.failures.length) {
    lines.push('未通过：');
    for (const f of report.failures) {
      lines.push(`  ✖ ${f.id}（${f.category}）「${f.question}」`);
      for (const v of f.violations) lines.push(`      - ${v}`);
    }
    lines.push('');
  }
  if (report.knownGaps.length) {
    lines.push('已知缺口（本批不修，只做退化监控）：');
    for (const g of report.knownGaps) {
      lines.push(`  ${g.ok ? '·' : '△'} ${g.id}「${g.question}」${g.ok ? '当前已通过' : `当前仍未通过：${g.violations.join('；')}`}`);
      if (g.gap_note) lines.push(`      ${g.gap_note}`);
    }
    lines.push('');
  }
  const hostOnly = report.results.filter((r) => r.host_only.expect_tools.length || r.host_only.forbidden_conclusions.length);
  lines.push(
    '⚠️ 本报告只覆盖【服务端证据】：金标片段有没有被检索并给出、该空的是不是真空、有没有越权串页。',
    `另有 ${hostOnly.length} 条问句带着「期望调用的工具 / 不得出现的结论」标注——这两项本 runner 不判分，`,
    '必须在真实宿主 + 真实模型上另做验收（工具选择看客户端会话轨迹，结论对错要人工逐条比对金标规则）。',
  );
  return lines.join('\n');
}
