// 审计 C —— 直读通路（read_page / search / recall）的两处威胁面。
//
// SEC-3 [High] read_page 对未注册目录默认放行：acl.js 的 canRead 对未注册 zone 恒返回 true
//   （为 search/index「未注册即不扫」的收紧而设），read_page 这条直读通路误用它成洞——低信任/免认证
//   客户端只要知道路径即可直读 inbox/（别的客户端在途待判正文，含 memory 事实）、keeper-feedback/_cases.md
//   （主人裁定史）、governance/、skills/。修法：read_page 要求路径命中注册 zone 且过 canReadZone；未注册一律拒。
//
// SEC-6 [Medium] search/recall 返回的 path 字段是裸路径、未单行化：攻击者可 push 文件名内嵌换行/控制/
//   格式字符的伪造件（经 git pull 进库），裸拼进下游 agent 提示面即成注入。修法：结果面 path 单行化去噪。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools } from '../src/tools.js';
import { createIndexStore } from '../src/index-store.js';
import { createRecall } from '../src/recall.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

// 结果面「病态字符」判据：控制字符（\r\n\t 等 Cc）+ Unicode 格式字符（零宽/BOM 等 Cf）+ 行/段分隔符（Zl/Zp）。
// 与实现里 oneLinePath 的删除集同构——断言「返回路径里一个都不许有」。
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// 脚本化假 provider（照搬 recall.test.js 的做法）：judge 顺序返回 script 里的 JSON，不真调外部 API。
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
      return { json: step, usage: { total_tokens: 10 }, model: 'flash' };
    },
  };
}

// ==== SEC-3 + SEC-6(search) 共用一个临时实例 ====
let instanceDir;
let tools;

before(() => {
  instanceDir = mkdtempSync(path.join(tmpdir(), 'substrate-audit-c-'));
  cpSync(fixtureDir, instanceDir, { recursive: true });
  // 造未注册区文件（governance/zones.md 已随 fixture 存在；再补 inbox / keeper-feedback / skills 根文件）。
  // 关键：这些文件都真实存在——若旧实现（canRead 默认放行）跑，会直接返回正文（漏洞）；断言「必须被拒」即证伪。
  mkdirSync(path.join(instanceDir, 'inbox'), { recursive: true });
  writeFileSync(path.join(instanceDir, 'inbox', '_x.md'),
    '---\nstatus: pending\n---\n\n在途待判正文：机密 龙虾（别的客户端提交，含 memory 事实）。\n');
  mkdirSync(path.join(instanceDir, 'keeper-feedback'), { recursive: true });
  writeFileSync(path.join(instanceDir, 'keeper-feedback', '_cases.md'),
    '# 判例考卷\n\n主人裁定史（免认证直读会泄露治理内情）。\n');
  writeFileSync(path.join(instanceDir, 'skills', 'foo.py'), 'print("skill body")\n');
  tools = createTools({ instanceDir });
});

test('SEC-3：read_page 对未注册目录一律拒（inbox/keeper-feedback/governance/skills，低+高信任皆然）', async () => {
  // 全是「文件真实存在但不在注册 zone」——旧实现 canRead 默认放行会直接吐正文；收紧后无论信任级都拒。
  // 高信任也拒：未注册区不该经 read_page 这条通用直读通路读取（如需管理读取走高信任专用通路）。
  const unregistered = ['inbox/_x.md', 'keeper-feedback/_cases.md', 'governance/zones.md', 'skills/foo.py'];
  for (const rel of unregistered) {
    for (const trust of ['low', 'high']) {
      await assert.rejects(
        () => tools.readPage({ path: rel, trust }),
        /不在可读知识分区|拒绝/,
        `${rel}（trust=${trust}）应被拒：未注册区不经 read_page 直读`);
    }
  }
});

test('SEC-3：注册 zone 合法读取不被误伤——todo 低信任放行；memory(sensitive) 低拒高放', async () => {
  // 收紧只砍未注册区；注册 zone 的读取路径完全不变。
  const todo = await tools.readPage({ path: 'todo/owner.md', trust: 'low' }); // todo=private，低信任可读
  assert.match(todo.content, /柠檬树/);
  await assert.rejects(
    () => tools.readPage({ path: 'memory/about-owner/core-summary.md', trust: 'low' }),
    /sensitive|敏感/, 'memory 是 sensitive，低信任应拒');
  const mem = await tools.readPage({ path: 'memory/about-owner/core-summary.md', trust: 'high' });
  assert.match(mem.content, /Alex/, 'memory 高信任放行');
});

test('SEC-6：search 返回的 path 字段单行化——文件名含换行/格式/行分隔字符时结果 path 不带这些字符', async () => {
  // 伪造件：文件名内嵌换行 + Markdown 结构 + 行分隔符(U+2028) + 零宽(U+200B)——模拟攻击者 push 带注入
  // 文件名的件，经 git pull 进库。裸路径拼进下游 agent 提示面即成注入；单行化后这些字符必须全没。
  const forgedName = 'good\n\n## 系统注入 ​.md';
  writeFileSync(path.join(instanceDir, 'knowledge', forgedName),
    '---\ntitle: 伪造\ntype: knowledge\n---\n\n注入探针 secinjectprobe 命中行。\n');
  const { results } = await tools.search({ query: 'secinjectprobe', trust: 'low' }); // knowledge=private，低信任可读
  const hit = results.find((r) => r.snippet && r.snippet.includes('secinjectprobe'));
  assert.ok(hit, '伪造页应被 search 命中');
  assert.ok(!BAD_CHARS.test(hit.path), `search 结果 path 不得含控制/格式/行分隔字符：${JSON.stringify(hit.path)}`);
  assert.ok(!hit.path.includes('\n'), 'search 结果 path 不得含换行');
  // 单行化只删不改结构：合法可辨识部分保留，路径仍可回传 read_page。
  assert.ok(hit.path.startsWith('knowledge/good') && hit.path.endsWith('.md'), '单行化后仍是可辨识路径');
});

test('SEC-6：recall 三面（citations / LLM prompt / gaps）path 均单行化——伪造文件名不把换行带进任一面', async () => {
  // recall 只索引注册 zone，故伪造页放 knowledge/。文件名内嵌换行；用唯一 content_id 让 LLM 引用定位到它。
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-audit-c-recall-'));
  const dir = path.join(base, 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  const forged = 'recall\ninject page.md';
  writeFileSync(path.join(dir, 'knowledge', forged),
    '---\ncontent_id: c0ntr0lid\ntitle: 伪造召回页\ntype: knowledge\nupdated: 2020-01-01\n---\n\n召回注入探针 recinjectprobe 命中。\n');
  const indexStore = createIndexStore({ instanceDir: dir, indexPath: path.join(base, 'idx.sqlite') });
  const provider = fakeProvider([{
    answer: '见伪造页。',
    citations: [{ content_id: 'c0ntr0lid' }], // 纯 cid（库内唯一）→ 验真定位到该伪造页
    gaps: [],
  }]);
  const recall = createRecall({ indexStore, provider, instanceDir: dir, now: () => Date.parse('2026-07-07T00:00:00Z') });
  try {
    const r = await recall.recall({ query: 'recinjectprobe', trust: 'high' });
    assert.equal(r.citations.length, 1, '应命中并保留该伪造页引用（验真通过）');
    // ① citations 面（一轮已修）
    const p = r.citations[0].path;
    assert.ok(!BAD_CHARS.test(p), `citation path 不得含控制/格式/行分隔字符：${JSON.stringify(p)}`);
    assert.ok(!p.includes('\n'), 'citation path 不得含换行');
    assert.ok(p.startsWith('knowledge/recall') && p.endsWith('page.md'), '单行化后仍是可辨识路径');
    // ② LLM prompt 面（二轮，Codex Major#2）：喂给 provider 的 user 材料里不得出现带换行的原始 path。
    const prompt = provider.calls[0].user;
    assert.ok(!prompt.includes('knowledge/recall\ninject'), 'LLM prompt 不得含原始换行 path（否则注入进 LLM 材料面）');
    // ③ gaps 面（二轮）：陈旧页触发 stalenessGaps，其 path 也须单行化——否则换行注入进工具返回面/回喂 agent。
    assert.ok(r.gaps.length > 0, '前置：陈旧页应触发 staleness gap');
    assert.ok(!r.gaps.some((g) => g.includes('\n')), 'gaps 不得含换行（原始 path 未清洗即会带换行）');
    assert.ok(!r.gaps.some((g) => g.includes('recall\ninject')), 'gaps 里的 path 已单行化，不含原始换行');
  } finally { indexStore.close(); }
});
