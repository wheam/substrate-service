import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';

let origin, work, inbox;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-inbox-'));
  origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seedDir]);
  writeFileSync(path.join(seedDir, 'README.md'), 'seed\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  inbox = createInbox({ instanceDir: work, writer: createWriter({ instanceDir: work }) });
});

test('addEntry：秒回受理回执，文件落 inbox/ 且带完整 frontmatter', async () => {
  const receipt = inbox.addEntry({ kind: 'save', content: '今天决定用 DeepSeek 起步', hint: '决定', client: 'cc-test' });
  assert.ok(receipt.id);
  assert.match(receipt.path, /^inbox\/_/, '文件名 _ 前缀（doctor 结构页豁免）');
  assert.equal(receipt.status, 'pending');
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /^---\n/);
  assert.match(raw, /title: 收件 /);
  assert.match(raw, /created: \d{4}-\d{2}-\d{2}/);
  assert.match(raw, /updated: \d{4}-\d{2}-\d{2}/);
  assert.match(raw, /type: inbox/);
  assert.match(raw, new RegExp(`id: ${receipt.id}`));
  assert.match(raw, /kind: save/);
  assert.match(raw, /client: cc-test/);
  assert.match(raw, /status: pending/);
  assert.match(raw, /hint: 决定/);
  assert.match(raw, /今天决定用 DeepSeek 起步/);
  await receipt.synced; // 后台 commit+push 完成
  assert.match(git(origin, 'log', '--oneline', '-1'), new RegExp(receipt.id));
});

test('addEntry：collection 类携带 name 与结构化 row', async () => {
  const receipt = inbox.addEntry({
    kind: 'collection', client: 'cc-test',
    payload: { name: 'restaurants', row: { name: '测试餐厅', city: '样例城' } },
  });
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /kind: collection/);
  assert.match(raw, /collection: restaurants/);
  assert.match(raw, /测试餐厅/);
  await receipt.synced;
});

test('addEntry：内容含疑似密钥 → 拒收不落盘（红线扫描在写路径）', async () => {
  assert.throws(
    () => inbox.addEntry({ kind: 'save', content: '我的 key 是 sk-ant-api03-abcdefghij1234567890', client: 'cc-test' }),
    /疑似密钥|凭据/
  );
  const files = readdirSync(path.join(work, 'inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    assert.ok(!readFileSync(path.join(work, 'inbox', f), 'utf8').includes('sk-ant-api03'), '密钥不应落盘');
  }
});

test('addEntry：空白/换行混淆的 key 也拒收（红线堵空白/换行绕过）', async () => {
  // 空格切碎：sk- 前缀后每段都不足 20 连续字符，原始扫描每段单看都逃过 \bsk-[A-Za-z0-9]{20,}
  assert.throws(
    () => inbox.addEntry({ kind: 'save', content: '记一下 sk-ab cd ef gh ij 0123 4567 89ab cdef 别弄丢了', client: 'cc-test' }),
    /疑似密钥|凭据/,
    '空格分段的 sk- key 必须被拒（折叠空白后连续 20+）',
  );
  // 换行切碎：同一把 key 被 \n 断开
  assert.throws(
    () => inbox.addEntry({ kind: 'save', content: '密钥分段：sk-abcdefghij\n0123456789abcd', client: 'cc-test' }),
    /疑似密钥|凭据/,
    '换行分段的 sk- key 必须被拒',
  );
  // 折叠空白后的密钥原文绝不落盘
  const files = readdirSync(path.join(work, 'inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    const collapsed = readFileSync(path.join(work, 'inbox', f), 'utf8').replace(/\s+/g, '');
    assert.ok(!/sk-abcdefghij0123456789abcd/.test(collapsed), '混淆 key 折叠后不应落盘');
  }
});

test('addEntry：良性长文（含 task/risk/disk 等 sk 子串、URL、数字）不误伤（FP 护栏）', async () => {
  // 折叠所有空白后仍是 352 字符的连续串，却不含任何凭据前缀在词边界处——不得因「长连续串」被误拒。
  const benign = [
    '今天整理了一下工程笔记：这个项目的检索任务（task）风险（risk）主要在磁盘（disk）IO 上，',
    '我们讨论了 JavaScript 和 TypeScript 的取舍，也顺带聊到向量数据库、缓存策略和幂等性设计。',
    'Ask the team to benchmark the framework before we commit to the architecture; ',
    'the desktop client and the server share a common schema and a retry policy with exponential backoff. ',
    '参考链接 https://example.com/engineering/notes-2026 里有更详细的基准数据，',
    '大概是每秒处理 12000 到 34000 条记录，延迟中位数在 8 毫秒左右，尾延迟需要继续优化。',
  ].join('');
  const receipt = inbox.addEntry({ kind: 'capture', content: benign, client: 'cc-test' });
  assert.ok(receipt.id, '良性长文应正常受理，不触发红线');
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /kind: capture/);
  assert.match(raw, /the framework before we commit/);
  await receipt.synced;
});

test('addEntry：零宽/格式字符拆分的 key 也拒收，且含零宽字符的正常长文不误伤（红线堵隐形 Unicode，\\p{Cf} FP 护栏）', async () => {
  // 零宽空格 U+200B：category Cf，\s 不匹配（旧折叠 replace(/\s+/g,'') 漏掉）、\p{Cf} 匹配。用转义写、源码不藏隐形字符。
  const ZWSP = '\u200B';
  // 明显伪造的 key：sk- 后接零宽空格拆碎的假字母数字；每段都不足 20 连续字符（原始扫描逐段逃过 \bsk-[A-Za-z0-9]{20,}），
  // 剥掉零宽字符后连续 24 字符 → 命中。旧折叠只去 \s、留下零宽字符 → 折叠副本也逃过 → 隐形拆分的 key 进 inbox（漏洞）。
  const split = `sk-abcde${ZWSP}fghij0123${ZWSP}456789abcd`;
  assert.throws(
    () => inbox.addEntry({ kind: 'save', content: `顺手记个配置：${split} 别弄丢了`, client: 'cc-test' }),
    /疑似密钥|凭据/,
    '零宽空格拆分的 sk- key 必须被拒（折叠 \\p{Cf} 后连续 20+）',
  );
  // 折叠掉空白与零宽/格式字符后的密钥原文绝不落盘
  const files = readdirSync(path.join(work, 'inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    const collapsed = readFileSync(path.join(work, 'inbox', f), 'utf8').replace(/[\s\p{Cf}]+/gu, '');
    assert.ok(!/sk-abcdefghij0123456789abcd/.test(collapsed), '零宽混淆 key 折叠后不应落盘');
  }
  // FP 护栏：正常长文里偶发零宽字符（复制粘贴常见）不得被误拒——\p{Cf} 是隐形格式字符、正常内容极罕见，
  // 剥掉它不改变可见文字，benign prose 里不含任何词边界处的凭据前缀，应正常受理。
  const benign = `工程周报${ZWSP}：本周完成检索模块基准测试，磁盘 IO 是主要瓶颈；团队讨论了缓存与幂等性设计，` +
    `参考 https://example.com/engineering/notes 里的数据，延迟中位数约 8 毫秒，尾延迟继续优化。`;
  const receipt = inbox.addEntry({ kind: 'capture', content: benign, client: 'cc-test' });
  assert.ok(receipt.id, '含零宽字符的正常长文应正常受理，不触发红线');
  await receipt.synced;
});

test('addEntry：组合标记/variation selector 拆分的 key 也拒收（红线堵 \\p{Mn}/\\p{Me} 类隐形拆分，非 \\p{Cf}）', async () => {
  // variation selector-16 U+FE0F 与 combining grapheme joiner U+034F 都是 \p{Mn}（组合标记），不是 \p{Cf}：
  // \s 与 \p{Cf} 都不匹配 → 夹进 sk- key 段间可同时逃过原文扫描与「只剥 [\s\p{Cf}]」的折叠副本（Codex 复核 PoC）。
  // 折叠副本须扩为剥 [\s\p{Cf}\p{Mn}\p{Me}\p{Cc}] 才能去掉这类隐形字符、还原连续 20+ 密钥而命中。用转义写、源码不藏隐形字符。
  const VS16 = '\uFE0F';  // \p{Mn}
  const CGJ = '\u034F';   // \p{Mn}
  for (const [label, split] of [
    ['variation selector', `sk-abcde${VS16}fghij0123${VS16}456789abcd`],
    ['combining grapheme joiner', `sk-abcde${CGJ}fghij0123${CGJ}456789abcd`],
  ]) {
    assert.throws(
      () => inbox.addEntry({ kind: 'save', content: `配置项：${split}`, client: 'cc-test' }),
      /疑似密钥|凭据/,
      `${label} 拆分的 sk- key 必须被拒（折叠 \\p{Mn} 后连续 20+）`,
    );
  }
  // 密钥原文（含组合标记的段）绝不落盘
  const files = readdirSync(path.join(work, 'inbox')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  for (const f of files) {
    const collapsed = readFileSync(path.join(work, 'inbox', f), 'utf8').replace(/[\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]+/gu, '');
    assert.ok(!/sk-abcdefghij0123456789abcd/.test(collapsed), '组合标记混淆 key 折叠后不应落盘');
  }
  // FP 护栏：正常多语言文本里的组合重音（组合式 café=cafe+U+0301、naïve=nai+U+0308+ve）剥掉 \p{Mn} 后
  // 还原为 cafe/naive，不巧合形成任何凭据前缀 → 正常受理，剥组合标记不误伤真实内容。
  const accented = `咖啡笔记：cafe\u0301 拿铁与 nai\u0308ve 手冲对比，萃取温度约 92 度，` +
    `记录风味曲线与 https://example.com/coffee 的评测差异，回头补充闷蒸时间与水温梯度。`;
  const receipt = inbox.addEntry({ kind: 'capture', content: accented, client: 'cc-test' });
  assert.ok(receipt.id, '含组合重音的正常长文应正常受理，不触发红线');
  await receipt.synced;
});

test('addEntry：连发两条 id 不撞、都入 git', async () => {
  const a = inbox.addEntry({ kind: 'todo', content: '买牛奶', client: 'cc-test' });
  const b = inbox.addEntry({ kind: 'todo', content: '修灯', client: 'cc-test' });
  assert.notEqual(a.id, b.id);
  await Promise.all([a.synced, b.synced]);
  const log = git(origin, 'log', '--oneline', '-4');
  assert.match(log, new RegExp(a.id));
  assert.match(log, new RegExp(b.id));
});
