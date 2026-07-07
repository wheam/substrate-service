import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newContentId, readContentId, addContentIdToFrontmatter } from '../src/content-id.js';
import { backfill } from '../scripts/backfill-content-id.js';
import { parseZones } from '../src/acl.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/backfill-content-id.js', import.meta.url));

function tmpInstance(tag) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), `substrate-${tag}-`)), 'instance');
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

// ==== content_id 原语 ====

test('newContentId：8 位 hex，随机（内容无关）', () => {
  const id = newContentId();
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.notEqual(id, newContentId());
});

test('addContentIdToFrontmatter：插入为 frontmatter 首字段；已有则幂等返回 null', () => {
  const page = '---\ntitle: 某页\ntype: knowledge\n---\n\n正文。\n';
  const first = addContentIdToFrontmatter(page, 'abcd1234');
  assert.equal(readContentId(first.text), 'abcd1234');
  assert.match(first.text, /^---\ncontent_id: abcd1234\ntitle: 某页/);
  assert.equal(addContentIdToFrontmatter(first.text), null, '已有 content_id → 幂等 null');
  assert.equal(addContentIdToFrontmatter('无 frontmatter 的纯文本'), null, '无 frontmatter → 不碰');
});

test('readContentId：只认首个 frontmatter 块，正文同名字样不算', () => {
  const raw = '---\ncontent_id: aaaa1111\ntitle: t\n---\n\ncontent_id: fake9999 出现在正文里\n';
  assert.equal(readContentId(raw), 'aaaa1111');
});

// ==== backfill 幂等 ====

test('backfill：给存量页回填 content_id，跑两遍幂等（id 不变、第二遍零回填）', () => {
  const dir = tmpInstance('backfill');
  const run1 = backfill(dir, { apply: true });
  assert.ok(run1.filled.length >= 2, '至少 knowledge 与 memory 两页被回填');
  const coffee = path.join(dir, 'knowledge', 'coffee-brewing.md');
  const id1 = readContentId(readFileSync(coffee, 'utf8'));
  assert.match(id1, /^[0-9a-f]{8}$/);

  const run2 = backfill(dir, { apply: true });
  assert.equal(run2.filled.length, 0, '第二遍无新回填（幂等）');
  assert.equal(readContentId(readFileSync(coffee, 'utf8')), id1, 'content_id 稳定不变');
});

test('backfill：跳过 README / inbox 流水条目 / 无 frontmatter；dry-run 不写盘', () => {
  const dir = tmpInstance('backfill-scope');
  // 造一个 inbox 流水条目（`_` 前缀）——必须被跳过
  const inboxDir = path.join(dir, 'inbox');
  execFileSync('mkdir', ['-p', inboxDir]);
  const fluxRel = 'inbox/_2026-07-05-x.md';
  writeFileSync(path.join(dir, fluxRel), '---\ntitle: 收件\nstatus: pending\n---\n\n随手一段\n');

  const dry = backfill(dir, { apply: false });
  assert.ok(!dry.filled.some((f) => f.path === fluxRel), 'inbox 流水条目不回填');
  assert.equal(readContentId(readFileSync(path.join(dir, fluxRel), 'utf8')), null, 'inbox 条目无 content_id');
  // dry-run 不写盘：coffee 页仍无 id
  assert.equal(readContentId(readFileSync(path.join(dir, 'knowledge', 'coffee-brewing.md'), 'utf8')), null);
});

test('缺陷6：backfill 新生成 id 与存量/本轮已分配 id 去重（撞库重摇），回填后全库唯一', () => {
  const dir = tmpInstance('backfill-dedup');
  // 给 coffee 页一个固定存量 id，作为「会被撞上」的目标
  const coffee = path.join(dir, 'knowledge', 'coffee-brewing.md');
  writeFileSync(coffee, addContentIdToFrontmatter(readFileSync(coffee, 'utf8'), 'aaaa0001').text);
  // 注入生成器：先连续吐「与存量相撞的 id」，再吐唯一 id——验证 while 重摇能跳过撞库
  const seq = ['aaaa0001', 'aaaa0001', 'bbbb0002', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'ffff0006'];
  let i = 0;
  const newId = () => seq[Math.min(i++, seq.length - 1)];
  const { filled } = backfill(dir, { apply: true, newId });
  const newIds = filled.map((f) => f.content_id);
  assert.ok(!newIds.includes('aaaa0001'), '新生成 id 不得与存量 id 相撞（撞库被重摇跳过）');
  const all = [...newIds, 'aaaa0001'];
  assert.equal(new Set(all).size, all.length, 'content_id 全库唯一（存量 + 新生成）');
});

test('backfill CLI：dry-run 入口可跑，退出码 0', () => {
  const dir = tmpInstance('backfill-cli');
  const out = execFileSync('node', [scriptPath, dir], { encoding: 'utf8' });
  assert.match(out, /dry-run/);
  // 仍未写盘
  assert.equal(readContentId(readFileSync(path.join(dir, 'knowledge', 'coffee-brewing.md'), 'utf8')), null);
});

// ==== doctor/curate 宽容性（M4.1 前提：引擎零改动，未知 frontmatter 键不报 error）====
// 说明：真实 vendored doctor.py 不在本服务仓库（在真实例私库）；fixture 只 vendored 了
// curate.py / collections.py / render-context.py 三个 stub。这里验证——服务运行时【实际会调用】的
// 那个 vendored 脚本（curate.py reindex）对带未知键（content_id/tier/source_agent/epistemic_type）
// 的页宽容不报错；且服务自己的 frontmatter 解析（parseZones 等）同样宽容。
test('doctor 宽容性：curate.py reindex 对含未知 frontmatter 键的页不报 error', () => {
  const dir = tmpInstance('doctor-tolerance');
  const coffee = path.join(dir, 'knowledge', 'coffee-brewing.md');
  let raw = readFileSync(coffee, 'utf8');
  // 塞进 M4.x 计划的所有新键
  raw = raw.replace(/^---\n/, [
    '---',
    'content_id: deadbeef',
    'tier: canonical',
    'source_agent: cc-mbp',
    'epistemic_type: fact',
    '',
  ].join('\n'));
  writeFileSync(coffee, raw);

  // 服务写路径实际会调的 vendored 脚本：curate.py reindex（cwd=实例，--instance .）
  const curate = path.join(dir, 'skills', 'substrate-curator', 'curate.py');
  const out = execFileSync('python3', [curate, 'reindex', '--instance', '.', '--dir', 'knowledge', '--apply'],
    { cwd: dir, encoding: 'utf8' });
  assert.match(out, /reindexed/, 'curate.py 正常完成，未因未知键失败');

  // 服务自身解析对未知键也宽容：parseZones 仍工作；页仍可原样读回、未知键保留
  assert.ok(parseZones(dir).some((z) => z.id === 'knowledge'));
  const after = readFileSync(coffee, 'utf8');
  assert.match(after, /content_id: deadbeef/);
  assert.match(after, /epistemic_type: fact/);
});
