// recall 证据扩展（知识库易用性首批）：
// 命中章节 + 邻接上下文 + 预算/候选截断诚实表达 + 扩展前重校验（ACL / tier / 文件身份 / 路径），
// 以及「未命中 ≠ 从未保存」的措辞契约。
//
// 关键立场：本文件只测【服务端确定性行为】——检索到什么证据、给 LLM 看到了什么、返回什么截断信号。
// 假 provider 的答案文本不是宿主模型行为的验收（真模型答案质量另测，见 docs/08-knowledge-usability.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexStore } from '../src/index-store.js';
import { createRecall } from '../src/recall.js';
import { collectEvidence, parseSections, EVIDENCE_BUDGET_CHARS } from '../src/evidence.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

// 一页「同一页多章节 + 后半段硬规则/例外 + 新旧冲突」的长规则页：
// 前部塞纯 ASCII/无关 CJK 填充撑过整页阈值，保证走【章节抽取】而非整页直出。
function hotelRulesPage() {
  const filler = Array.from({ length: 40 },
    (_, i) => `背景说明 filler line ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.`);
  return [
    '---',
    'content_id: 7777aaaa',
    'title: 订酒店的个人规则',
    'type: knowledge',
    'updated: 2026-08-20',
    '---',
    '',
    '# 订酒店的个人规则',
    '',
    '## 背景',
    '',
    ...filler,
    '',
    '## 预算',
    '',
    '每晚预算上限 1200 元，超出要先问我。',
    '',
    '## 硬规则',
    '',
    '必须可免费取消，不接受不可取消的特价房。',
    '',
    '## 例外',
    '',
    '例外：公司统一预订的会议酒店可以突破 1200 元上限，但仍必须可免费取消。',
    '',
    '## 变更记录',
    '',
    '2024 年的旧规则是每晚预算上限 800 元；2026-08 起改为 1200 元，旧规则作废。',
    '',
  ].join('\n');
}

function tmpInstance(tag, extra = {}) {
  const base = mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`));
  const dir = path.join(base, 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  writeFileSync(path.join(dir, 'knowledge', 'hotel-rules.md'), hotelRulesPage());
  for (const [rel, text] of Object.entries(extra)) writeFileSync(path.join(dir, rel), text);
  return { base, dir, indexPath: path.join(base, 'idx.sqlite') };
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
      return { json: step, usage: { total_tokens: 10 }, model: 'fake-offline' };
    },
  };
}

const HOTEL_CITE = { path: 'knowledge/hotel-rules.md', content_id: '7777aaaa' };

function makeRecall(tag, script, opts = {}, extra = {}) {
  const { base, dir, indexPath } = tmpInstance(tag, extra);
  const indexStore = createIndexStore({ instanceDir: dir, indexPath });
  const provider = fakeProvider(script);
  const recall = createRecall({ indexStore, provider, instanceDir: dir, ...opts });
  return { base, dir, indexStore, provider, recall };
}

const evidenceText = (r) => (r.evidence ?? []).map((e) => e.text).join('\n');

test('只命中标题：预算内读全长页，后半段规则不能静默遗漏', () => {
  const { dir } = tmpInstance('ev-heading-only');
  const content = ['# 酒店选择规则', '', '## 背景',
    ...Array(100).fill('背景资料：这是出行经验笔记，用于记录城市环境和过往见闻。'),
    '## 必须满足', '必须提供免费停车。', '## 例外', '不租车可忽略停车要求。'].join('\n');
  writeFileSync(path.join(dir, 'knowledge/hotel-rules.md'), content);
  const r = collectEvidence({ instanceDir: dir, trust: 'high',
    candidates: [{ path: 'knowledge/hotel-rules.md', content_id: null, lines: [1] }] });
  assert.match(r.pages[0].blocks.map((b) => b.text).join('\n'), /不租车可忽略停车要求/);
  assert.equal(r.truncated, false);
});

test('章节选择本身遗漏内容时也要通过 recall 返回不完整提示', async () => {
  const { dir, indexStore, recall } = makeRecall('ev-selection-partial', [{
    answer: '部分材料', citations: [HOTEL_CITE], gaps: [],
  }]);
  writeFileSync(path.join(dir, 'knowledge/hotel-rules.md'),
    '---\ncontent_id: 7777aaaa\n---\n# 出行记录\n## 停车\n免费停车政策。\n## 背景\n' +
    '与查询无关的背景资料。\n'.repeat(300) + '\n## 例外\n不租车可忽略上述要求。');
  try {
    const r = await recall.recall({ query: '免费停车政策', trust: 'high' });
    assert.ok(r.truncated?.incomplete.some((p) => p.path === HOTEL_CITE.path));
    assert.ok(r.gaps.some((g) => /read_page/.test(g)));
  } finally { indexStore.close(); }
});

test('单行被截短不能标成全文，部分行信息随证据与引用返回', async () => {
  const { dir, indexStore, recall } = makeRecall('ev-partial-line', [{ answer: 'x', citations: [HOTEL_CITE], gaps: [] }], { evidenceBudget: 600 });
  writeFileSync(path.join(dir, 'knowledge/hotel-rules.md'),
    '---\ncontent_id: 7777aaaa\n---\n停车政策：' + '说明'.repeat(700) + '必须免费停车');
  try {
    const r = await recall.recall({ query: '停车政策', trust: 'high' });
    const e = r.evidence.find((e) => e.path === HOTEL_CITE.path);
    assert.equal(e.full_page, false);
    assert.equal(e.partial_line, true);
    assert.equal(r.citations[0].sections[0].partial_line, true);
    assert.ok(r.truncated);
  } finally { indexStore.close(); }
});

test('代码围栏中的井号行不是章节标题，真实规则仍属于原章节', () => {
  const p = parseSections('# 规则\n必须免费停车\n```text\n# 示例文本\n```\n例外：不租车\n## 预算\n220');
  assert.deepEqual(p.sections.map((s) => s.heading), ['规则', '预算']);
  assert.equal(p.sections[0].end, 6);
});

test('大章节按行裁剪：范围对应实际给出的前缀，字符预算不能超出', () => {
  const { dir } = tmpInstance('ev-large-section');
  writeFileSync(path.join(dir, 'knowledge/hotel-rules.md'), '# 大页\n' + ('背景 '.repeat(30) + '\n').repeat(10000));
  const r = collectEvidence({ instanceDir: dir, trust: 'high', budget: 600,
    candidates: [{ path: 'knowledge/hotel-rules.md', content_id: null, lines: [1] }] });
  assert.ok(r.used <= 600);
  assert.ok(r.truncated);
  assert.equal(r.pages[0].blocks[0].full_page, false);
});

// ==== 章节扩展：同一页多章节、后半段硬规则/例外、新旧冲突都要进证据 ====

test('章节扩展：命中散落在同页多个章节 → 硬规则、例外、新旧冲突全部进证据与 LLM 材料', async () => {
  const { indexStore, provider, recall } = makeRecall('ev-sections', [{
    answer: '订酒店：预算 1200，必须可免费取消。', citations: [HOTEL_CITE], gaps: [],
  }]);
  try {
    const r = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    const ev = evidenceText(r);
    for (const needle of ['1200', '免费取消', '会议酒店', '800']) {
      assert.match(ev, new RegExp(needle), `证据应含「${needle}」（后半段硬规则/例外/旧规则不得丢）`);
      assert.match(provider.calls[0].user, new RegExp(needle), `LLM 材料应含「${needle}」`);
    }
    assert.ok(r.evidence.length >= 2, '同页多个命中章节应各自成块');
    assert.ok(r.evidence.every((e) => e.path === 'knowledge/hotel-rules.md'));
    assert.ok(r.evidence.every((e) => /^\d+-\d+$/.test(e.lines)), '每块证据须带真实行号范围');
    assert.ok(r.evidence.some((e) => /例外|硬规则|变更记录/.test(e.heading ?? '')), '证据块应保留标题层级');
  } finally { indexStore.close(); }
});

test('章节扩展：引用绑定实际提供的章节与行范围', async () => {
  const { indexStore, recall } = makeRecall('ev-cite-sections', [{
    answer: 'x', citations: [HOTEL_CITE], gaps: [],
  }]);
  try {
    const r = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    assert.equal(r.citations.length, 1);
    const c = r.citations[0];
    assert.ok(Array.isArray(c.sections) && c.sections.length >= 1, '引用应绑定实际给出的章节');
    const given = new Set(r.evidence.filter((e) => e.path === c.path).map((e) => e.lines));
    for (const s of c.sections) assert.ok(given.has(s.lines), `引用的行范围 ${s.lines} 必须来自实际提供的证据`);
  } finally { indexStore.close(); }
});

test('短页直接给全文（不必逐章节切）', async () => {
  const { indexStore, recall } = makeRecall('ev-shortpage', [{
    answer: 'x', citations: [{ path: 'knowledge/coffee-brewing.md', content_id: null }], gaps: [],
  }]);
  try {
    const r = await recall.recall({ query: '手冲咖啡水温和粉水比', trust: 'high' });
    const block = r.evidence.find((e) => e.path === 'knowledge/coffee-brewing.md');
    assert.ok(block, '应召回咖啡页');
    assert.equal(block.full_page, true, '短页应整页给出');
    assert.match(block.text, /粉水比 1:15/);
    assert.match(block.text, /耶加雪菲/, '短页全文应含末尾的决定行');
  } finally { indexStore.close(); }
});

// ==== 预算 / 候选截断：必须诚实，不得把 8 页当全部 ====

test('证据预算截断：超预算时标 truncated、gaps 提示继续 read_page，且不谎称已给全部', async () => {
  const { indexStore, recall } = makeRecall('ev-budget', [{
    answer: 'x', citations: [HOTEL_CITE], gaps: [],
  }], { evidenceBudget: 600 });
  try {
    const r = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    assert.ok(r.truncated, '超预算应带 truncated');
    assert.equal(r.truncated.evidence_budget, 600);
    assert.ok(r.truncated.incomplete.length >= 1, '应点名哪些页未完整读取');
    assert.ok(r.gaps.some((g) => /read_page/.test(g)), 'gaps 应指路继续 read_page 补读');
    assert.ok(r.gaps.some((g) => /证据|不完整|截断/.test(g)), 'gaps 应说明证据不完整');
  } finally { indexStore.close(); }
});

test('候选页达上限：标 candidate_limit_reached + gaps 明说可能还有别的页', async () => {
  const extra = {};
  for (let i = 0; i < 12; i++) {
    extra[`knowledge/many-${i}.md`] =
      `---\ncontent_id: bbbb00${String(i).padStart(2, '0')}\ntitle: 多页 ${i}\ntype: knowledge\n---\n\n关于订酒店的第 ${i} 条零散笔记。\n`;
  }
  const { indexStore, recall } = makeRecall('ev-candlimit', [{ answer: 'x', citations: [HOTEL_CITE], gaps: [] }], {}, extra);
  try {
    const r = await recall.recall({ query: '订酒店', trust: 'high' });
    assert.equal(r.meta.candidate_count, 8, '候选上限 8 页');
    assert.ok(r.truncated?.candidate_limit_reached, '达上限应显式标记');
    assert.ok(r.gaps.some((g) => /候选页|还有|未纳入/.test(g)), 'gaps 应说明可能还有未纳入的页');
  } finally { indexStore.close(); }
});

test('无截断时不带 truncated 字段（与 search 风格一致，向后兼容）', async () => {
  const { indexStore, recall } = makeRecall('ev-notrunc', [{
    answer: 'x', citations: [{ path: 'knowledge/coffee-brewing.md', content_id: null }], gaps: [],
  }]);
  try {
    const r = await recall.recall({ query: '手冲咖啡水温', trust: 'high' });
    assert.equal(r.truncated, undefined);
    assert.deepEqual(Object.keys(r).sort(), ['answer', 'citations', 'evidence', 'gaps', 'meta']);
  } finally { indexStore.close(); }
});

// ==== 未命中 ≠ 没存过 ====

test('零命中：措辞是「未检索到足够依据」，绝不称主人从未保存', async () => {
  const { indexStore, provider, recall } = makeRecall('ev-miss', [{ answer: '不该被调用', citations: [], gaps: [] }]);
  try {
    const r = await recall.recall({ query: 'zzz绝无此词xyz', trust: 'high' });
    assert.equal(provider.calls.length, 0, '零命中不调 LLM');
    assert.match(r.answer, /未检索到足够依据/);
    assert.doesNotMatch(r.answer, /库里没有|没存过|从未保存|没有存过/);
    assert.ok(r.gaps.length >= 1);
    for (const g of r.gaps) assert.doesNotMatch(g, /库里没有|没存过|从未保存/);
    assert.deepEqual(r.evidence, []);
  } finally { indexStore.close(); }
});

test('引用全部验真失败：降级措辞也不得称库里没有/没存过', async () => {
  const { indexStore, recall } = makeRecall('ev-degraded', [{
    answer: '（幻觉）随便编的酒店规则。',
    citations: [{ path: 'knowledge/does-not-exist.md', content_id: 'deadbeef' }],
    gaps: [],
  }]);
  try {
    const r = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    assert.equal(r.citations.length, 0);
    assert.doesNotMatch(r.answer, /库里没有|没存过|从未保存/);
    assert.match(r.answer, /未检索到足够依据|无法据此/);
  } finally { indexStore.close(); }
});

// ==== 扩展前重校验：ACL / tier / 文件身份 / 路径，失败不得退回旧索引片段 ====

test('tier 变更：索引仍是旧 canonical，扩展前重校验发现已降级 → 该页不进证据也不进 LLM', async () => {
  const { dir, indexStore, provider, recall } = makeRecall('ev-tier', [{ answer: 'x', citations: [], gaps: [] }]);
  try {
    await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' }); // 先建索引
    const p = path.join(dir, 'knowledge', 'hotel-rules.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('type: knowledge', 'type: knowledge\ntier: candidate'));
    const before = provider.calls.length;
    const r = await recall.recall({ query: '订酒店的预算和取消规则 candidate', trust: 'high' });
    assert.ok(!(r.evidence ?? []).some((e) => e.path === 'knowledge/hotel-rules.md'), '降级页不得进证据');
    assert.match(r.answer, /未检索到足够依据|无法作为证据读取/, '读不到要如实说，不能说成没存过');
    assert.doesNotMatch(r.answer, /没存过|从未保存/);
    for (const c of provider.calls.slice(before)) {
      assert.doesNotMatch(c.user, /免费取消/, '不得把旧索引片段当证据喂给 LLM');
    }
  } finally { indexStore.close(); }
});

test('文件身份变更：content_id 与索引不符 → 丢弃该页，不退回不可信的旧索引片段', async () => {
  const { dir, indexStore, provider, recall } = makeRecall('ev-cid', [{ answer: 'x', citations: [], gaps: [] }]);
  try {
    await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    const p = path.join(dir, 'knowledge', 'hotel-rules.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('content_id: 7777aaaa', 'content_id: 9999ffff'));
    const before = provider.calls.length;
    const r = await recall.recall({ query: '订酒店的预算和取消规则 变更', trust: 'high' });
    assert.ok(!(r.evidence ?? []).some((e) => e.path === 'knowledge/hotel-rules.md'), '身份不符的页不得进证据');
    assert.ok(r.truncated?.incomplete.some((x) => x.reason === 'identity'), '应把身份不符如实标出来');
    for (const c of provider.calls.slice(before)) {
      assert.doesNotMatch(c.user, /免费取消/, '不得退回旧索引片段');
    }
  } finally { indexStore.close(); }
});

test('符号链接外泄：knowledge 下指向实例外的软链 → 内容绝不进证据/LLM', async () => {
  const { base, dir, indexPath } = tmpInstance('ev-symlink');
  const secret = path.join(base, 'outside-secret.md');
  writeFileSync(secret, '---\ncontent_id: 5555eeee\ntitle: 外部机密\ntype: knowledge\n---\n\n订酒店的外部机密口令 symlinkleak2026。\n');
  symlinkSync(secret, path.join(dir, 'knowledge', 'linked.md'));
  const indexStore = createIndexStore({ instanceDir: dir, indexPath });
  const provider = fakeProvider([{ answer: 'x', citations: [], gaps: [] }]);
  const recall = createRecall({ indexStore, provider, instanceDir: dir });
  try {
    const r = await recall.recall({ query: '订酒店的机密口令', trust: 'high' });
    assert.ok(!(r.evidence ?? []).some((e) => e.path === 'knowledge/linked.md'), '软链页不得进证据');
    assert.doesNotMatch(JSON.stringify(r), /symlinkleak2026/, '外部内容不得出现在返回里');
    for (const c of provider.calls) assert.doesNotMatch(c.user, /symlinkleak2026/, '外部内容不得进 LLM 材料');
  } finally { indexStore.close(); }
});

test('越界候选路径：collectEvidence 直接拒绝 ../ 与绝对路径，不读盘外文件', () => {
  const { dir } = tmpInstance('ev-escape');
  const out = collectEvidence({
    instanceDir: dir,
    trust: 'high',
    candidates: [
      { path: '../outside.md', content_id: null, lines: [1], snippets: ['x'] },
      { path: '/etc/passwd', content_id: null, lines: [1], snippets: ['x'] },
      { path: 'knowledge/../../escape.md', content_id: null, lines: [1], snippets: ['x'] },
    ],
  });
  assert.deepEqual(out.pages, [], '越界路径一页都不得展开');
  assert.equal(out.dropped.length, 3);
  for (const d of out.dropped) assert.equal(d.reason, 'path');
});

test('collectEvidence 默认预算为 12000 字符（首批实验起始值）', () => {
  const { dir } = tmpInstance('ev-default-budget');
  const out = collectEvidence({ instanceDir: dir, trust: 'high', candidates: [] });
  assert.equal(out.budget, EVIDENCE_BUDGET_CHARS);
  assert.equal(EVIDENCE_BUDGET_CHARS, 12000);
});

// ==== 缓存：证据同缓存，且 ACL 改严后连证据一起失效 ====

test('缓存命中：证据与截断信号一并复用，不再调 LLM', async () => {
  const { indexStore, provider, recall } = makeRecall('ev-cache', [{
    answer: 'x', citations: [HOTEL_CITE], gaps: [],
  }]);
  try {
    const first = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    const second = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' });
    assert.equal(provider.calls.length, 1);
    assert.equal(second.meta.cached, true);
    assert.deepEqual(second.evidence, first.evidence, '缓存应复用同一份证据');
  } finally { indexStore.close(); }
});

test('缓存 + ACL 改严：即使当次没有 citations，缓存里的证据页也必须重过 ACL', async () => {
  const { dir, indexStore, recall } = makeRecall('ev-cache-acl', [
    // 引用全幻觉 → citations 空、evidence 非空：只有把 evidence 也纳入 ACL 复核才会失效
    { answer: 'x', citations: [{ path: 'knowledge/nope.md', content_id: 'deadbeef' }], gaps: [] },
    { answer: 'y', citations: [], gaps: [] },
  ]);
  try {
    const first = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'low' });
    assert.equal(first.citations.length, 0);
    assert.ok(first.evidence.length >= 1, '前提：低信任此时可读 knowledge');
    const zonesPath = path.join(dir, 'governance', 'zones.md');
    writeFileSync(zonesPath, readFileSync(zonesPath, 'utf8')
      .replace(/(- id: knowledge[\s\S]*?privacy: )private/, '$1sensitive'));
    const second = await recall.recall({ query: '订酒店的预算和取消规则', trust: 'low' });
    assert.deepEqual(second.evidence, [], 'zone 改严后不得复用缓存里的证据');
    assert.doesNotMatch(JSON.stringify(second), /免费取消/);
  } finally { indexStore.close(); }
});

// ==== 服务/工具错误不得伪装成内容缺失 ====

test('预算未读页的缓存路径也重过 ACL，过期索引不得泄漏不可读路径', async () => {
  const publicPath = 'knowledge/public.md';
  const hiddenPath = 'memory/about-owner/core-summary.md';
  const { dir } = tmpInstance('ev-cache-incomplete-acl', {
    [publicPath]: '酒店规则：' + '日常要求'.repeat(150),
  });
  const zonesPath = path.join(dir, 'governance/zones.md');
  const originalZones = readFileSync(zonesPath, 'utf8');
  writeFileSync(zonesPath, originalZones.replaceAll('privacy: sensitive', 'privacy: private'));
  // 固定 generation 与候选，模拟 ACL 变更后还没刷新的派生索引。
  const indexStore = { generation: () => 0, query: () => ({ results: [
    { path: publicPath, content_id: null, line: 1, snippet: '酒店规则', score: -2 },
    { path: hiddenPath, content_id: null, line: 1, snippet: '酒店规则', score: -1 },
  ] }) };
  const provider = fakeProvider([{ answer: '酒店规则', citations: [{ path: publicPath }], gaps: [] }]);
  const recall = createRecall({ instanceDir: dir, indexStore, provider, evidenceBudget: 600 });
  const first = await recall.recall({ query: '酒店', trust: 'low' });
  assert.ok(first.truncated?.incomplete.some((e) => e.path === hiddenPath));
  writeFileSync(zonesPath, originalZones);
  const second = await recall.recall({ query: '酒店', trust: 'low' });
  assert.equal(second.meta.cached, false);
  assert.ok(!JSON.stringify(second).includes(hiddenPath), '不可读路径也不得残留在截断提示中');
});

test('provider 故障：抛错交由上层 isError，不得伪装成「未检索到」的内容缺失', async () => {
  const { indexStore, recall } = makeRecall('ev-provider-err', [new Error('provider 503 unavailable')]);
  try {
    await assert.rejects(
      () => recall.recall({ query: '订酒店的预算和取消规则', trust: 'high' }),
      /provider 503/,
    );
  } finally { indexStore.close(); }
});
