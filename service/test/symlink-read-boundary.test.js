// 读取边界：实例里的符号链接不能让 read_page / search / 索引 / 夜班绕过 zone 与 trust 校验。
// 2026-10-18 审查复现：knowledge/ 下指向 memory/ 敏感页或实例外文件的别名可被低信任客户端读出、搜出、索引。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTools } from '../src/tools.js';
import { createIndexStore } from '../src/index-store.js';
import { createNightly } from '../src/nightly.js';
import { viaSymlink, walkRegularFiles } from '../src/safe-fs.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
let base;
let instance;

before(() => {
  base = mkdtempSync(path.join(tmpdir(), 'substrate-symlink-'));
  instance = path.join(base, 'instance');
  cpSync(fixtureDir, instance, { recursive: true });
  writeFileSync(path.join(instance, 'memory/about-owner/private-synthetic.md'),
    '---\ntitle: Synthetic\ntier: canonical\n---\n\nSensitiveReviewMarker\n');
  writeFileSync(path.join(base, 'outside-synthetic.txt'), 'OutsideReviewMarker\n');
  symlinkSync('../memory/about-owner/private-synthetic.md', path.join(instance, 'knowledge/alias-sensitive.md'));
  symlinkSync('../../outside-synthetic.txt', path.join(instance, 'knowledge/alias-outside.md'));
  mkdirSync(path.join(base, 'outside-dir'));
  writeFileSync(path.join(base, 'outside-dir', 'leak.md'), 'OutsideDirMarker\n');
  symlinkSync('../../outside-dir', path.join(instance, 'knowledge/alias-dir'));
  symlinkSync('..', path.join(instance, 'knowledge/loop')); // 环：遍历不得跟随
});

after(() => rmSync(base, { recursive: true, force: true }));

test('safe-fs：识别路径中的符号链接分量，遍历跳过链接', () => {
  assert.equal(viaSymlink(instance, 'knowledge/alias-sensitive.md'), true);
  assert.equal(viaSymlink(instance, 'knowledge/alias-dir/leak.md'), true);
  assert.equal(viaSymlink(instance, 'memory/about-owner/private-synthetic.md'), false);
  assert.equal(viaSymlink(instance, 'knowledge/not-yet-created.md'), false);
  const files = walkRegularFiles(instance, { exts: new Set(['.md']) });
  assert.ok(files.includes('memory/about-owner/private-synthetic.md'));
  assert.ok(!files.some((f) => f.startsWith('knowledge/alias') || f.startsWith('knowledge/loop')));
});

test('read_page 拒绝经过符号链接的路径（敏感页别名、实例外文件、链接目录）', async () => {
  const tools = createTools({ instanceDir: instance });
  await assert.rejects(tools.readPage({ path: 'memory/about-owner/private-synthetic.md', trust: 'low' }), /sensitive/);
  await assert.rejects(tools.readPage({ path: 'knowledge/alias-sensitive.md', trust: 'low' }), /符号链接/);
  await assert.rejects(tools.readPage({ path: 'knowledge/alias-outside.md', trust: 'high' }), /符号链接/);
  await assert.rejects(tools.readPage({ path: 'knowledge/alias-dir/leak.md', trust: 'high' }), /符号链接/);
});

test('search 与派生索引不收录符号链接别名', async () => {
  const tools = createTools({ instanceDir: instance });
  for (const marker of ['SensitiveReviewMarker', 'OutsideReviewMarker', 'OutsideDirMarker']) {
    const r = await tools.search({ query: marker, trust: 'low' });
    assert.deepEqual(r.results, [], marker);
  }
  const index = createIndexStore({ instanceDir: instance, indexPath: ':memory:' });
  try {
    index.rebuild();
    for (const marker of ['SensitiveReviewMarker', 'OutsideReviewMarker', 'OutsideDirMarker']) {
      assert.deepEqual(index.query({ query: marker, trust: 'low' }).results, [], marker);
    }
    index.updatePage('knowledge/alias-sensitive.md');
    assert.deepEqual(index.query({ query: 'SensitiveReviewMarker', trust: 'low' }).results, []);
  } finally { index.close(); }
});

test('夜班扫描不跟随符号链接（不会对别名目标降级或报告）', () => {
  const nightly = createNightly({ instanceDir: instance, notifier: { async notify() {} }, intervalMs: 0 });
  const found = nightly.scan();
  const touched = [...found.thin.map((t) => t.page), ...found.duplicates.flatMap((d) => [d.a, d.b])];
  assert.ok(!touched.some((p) => p.startsWith('knowledge/alias') || p.startsWith('knowledge/loop')), touched.join(','));
});
