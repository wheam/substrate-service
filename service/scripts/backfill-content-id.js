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
import { hasExplicitTier, setTierLine } from '../src/tier.js';
import { stripScalar } from '../src/acl.js';

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

// tier 可选（spec §6.1 迁移：无 tier 一律视同 canonical，故回填非强制——只是把隐式档写成显式）。
// tier=null → 完全不碰 tier（默认）。
// 缺陷5：迁移语义就是「存量页默认 canonical」（spec §6.5）——--tier 只接受缺省或 canonical。
// candidate/rejected（乃至任何其它值）会一键批量隔离整库存量页，是自毁通路 → 在写盘之前直接报错退出。
export function backfill(instanceDir, { apply = false, newId = newContentId, tier = null } = {}) {
  const filled = [], skipped = [], tiered = [];
  let wantTier = null;
  if (tier != null) {
    const t = stripScalar(tier).toLowerCase(); // 去引号/空白/大小写归一后精确判定
    if (t !== 'canonical') {
      throw new Error(`backfill --tier 只接受 canonical（迁移语义：存量页默认 canonical，spec §6.5）——拒绝 "${tier}"：candidate/rejected 会一键批量隔离存量页`);
    }
    wantTier = 'canonical';
  }
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
    let raw = readFileSync(abs, 'utf8');
    let changed = false;
    // content_id 回填（既有逻辑，只增不改、幂等）
    if (readContentId(raw)) {
      skipped.push(rel);
    } else {
      let id = newId();
      while (used.has(id)) id = newId(); // 与任何已存在/本轮已分配的 id 相撞 → 重摇
      const res = addContentIdToFrontmatter(raw, id);
      if (res) { raw = res.text; used.add(res.id); changed = true; filled.push({ path: rel, content_id: res.id }); }
      else skipped.push(rel); // 无 frontmatter 等 → 不碰
    }
    // tier 回填（可选）：只给「有 frontmatter 且无显式 tier」的页补，幂等（已有 tier 行不覆盖）
    if (wantTier && /^---\n[\s\S]*?\n---/.test(raw) && !hasExplicitTier(raw)) {
      raw = setTierLine(raw, wantTier);
      changed = true;
      tiered.push({ path: rel, tier: wantTier });
    }
    if (apply && changed) writeFileSync(abs, raw);
  }
  return { filled, skipped, tiered };
}

// 直接运行入口
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [, , instanceDir, ...flags] = process.argv;
  if (!instanceDir) {
    console.error('用法：node scripts/backfill-content-id.js <instanceDir> [--apply] [--tier[=canonical]]');
    process.exit(1);
  }
  const apply = flags.includes('--apply');
  // --tier（可选）：把无显式 tier 的存量页写成显式 canonical（或 --tier=candidate 等）。不传则完全不碰 tier。
  const tierFlag = flags.find((f) => f === '--tier' || f.startsWith('--tier='));
  const tier = tierFlag ? (tierFlag.includes('=') ? tierFlag.split('=')[1] : 'canonical') : null;
  let filled, skipped, tiered;
  try {
    ({ filled, skipped, tiered } = backfill(instanceDir, { apply, tier }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const f of filled) console.log(`${apply ? '回填' : '将回填'} ${f.path} → content_id: ${f.content_id}`);
  for (const t of tiered) console.log(`${apply ? '标注' : '将标注'} ${t.path} → tier: ${t.tier}`);
  console.log(`\n${apply ? '已写入' : 'dry-run'}：${filled.length} 页回填 content_id，${tiered.length} 页标注 tier，${skipped.length} 页跳过（已有 id / 无 frontmatter）。`);
  if (!apply && (filled.length || tiered.length)) console.log('（加 --apply 实际写入）');
}
