#!/usr/bin/env node
// backfill-content-id.js — 给存量页一次性回填 content_id（spec §6.5 迁移）。
//
// 幂等：已有 content_id 的页跳过；只增不改。安全：默认 dry-run，只有带 --apply 才写盘；
// 必须显式给实例目录（不猜路径），且默认不写——避免误伤真库。红线：先在 tmp 副本上验证，绝不跑真库。
//
// 用法：
//   node scripts/backfill-content-id.js <instanceDir>            # dry-run，列出会回填哪些页
//   node scripts/backfill-content-id.js <instanceDir> --apply    # 实际写入
//
// 范围：实例内所有内容页 .md，但跳过——
//   .git / node_modules；inbox/ 与 keeper-feedback/（流水区，非正典页）；
//   README.md 与 `_` 前缀文件（结构页/流水条目，doctor 豁免）；无 frontmatter 的文件。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { addContentIdToFrontmatter, readContentId, newContentId } from '../src/content-id.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'inbox', 'keeper-feedback']);

function walkPages(instanceDir) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(path.join(instanceDir, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(path.join(instanceDir, rel)).isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(rel);
        continue;
      }
      if (path.extname(name) !== '.md') continue;
      if (name === 'README.md' || name.startsWith('_')) continue;
      out.push(rel);
    }
  }
  return out;
}

export function backfill(instanceDir, { apply = false, newId = newContentId } = {}) {
  const filled = [], skipped = [];
  const pages = walkPages(instanceDir);
  // 缺陷6：先收集存量已有 id，新生成时避撞——撞库会让 index/recall 把引用归一化到错误页。
  // used 覆盖「存量已有」+「本轮已分配」，保证回填后全库 content_id 唯一。
  const used = new Set();
  for (const rel of pages) {
    const existing = readContentId(readFileSync(path.join(instanceDir, rel), 'utf8'));
    if (existing) used.add(existing);
  }
  for (const rel of pages) {
    const abs = path.join(instanceDir, rel);
    const raw = readFileSync(abs, 'utf8');
    if (readContentId(raw)) { skipped.push(rel); continue; }
    let id = newId();
    while (used.has(id)) id = newId(); // 与任何已存在/本轮已分配的 id 相撞 → 重摇
    const res = addContentIdToFrontmatter(raw, id);
    if (!res) { skipped.push(rel); continue; } // 无 frontmatter 等 → 不碰
    used.add(res.id);
    if (apply) writeFileSync(abs, res.text);
    filled.push({ path: rel, content_id: res.id });
  }
  return { filled, skipped };
}

// 直接运行入口
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [, , instanceDir, ...flags] = process.argv;
  if (!instanceDir) {
    console.error('用法：node scripts/backfill-content-id.js <instanceDir> [--apply]');
    process.exit(1);
  }
  const apply = flags.includes('--apply');
  const { filled, skipped } = backfill(instanceDir, { apply });
  for (const f of filled) console.log(`${apply ? '回填' : '将回填'} ${f.path} → content_id: ${f.content_id}`);
  console.log(`\n${apply ? '已写入' : 'dry-run'}：${filled.length} 页回填，${skipped.length} 页跳过（已有 id / 无 frontmatter）。`);
  if (!apply && filled.length) console.log('（加 --apply 实际写入）');
}
