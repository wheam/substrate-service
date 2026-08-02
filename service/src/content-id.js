// content_id：页/条目的稳定短 id（8 位 hex，内容无关的随机——初次生成后写进 frontmatter、不再变，扛改名）。
// 索引与（未来的）链接引用它。写侧建页/按 id 定位、backfill、index-store 共用。
// 只做 frontmatter 文本层面的增/读，不引 YAML 依赖——与引擎 doctor / 本服务其它解析同族（正则抽固定键）。
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function newContentId() {
  return crypto.randomBytes(4).toString('hex'); // 8 位 hex，2^32 空间，个人库规模足够
}

// 从页原文读 content_id（无则 null）。只认首个 frontmatter 块里的键，正文里的同名字样不算。
export function readContentId(raw) {
  const fm = String(raw).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return fm.match(/^content_id:\s*(.+)$/m)?.[1]?.trim() || null;
}

// 给存量页的 frontmatter 插入 content_id（作为块内首字段，稳定可见）。
// 返回 { text, id }；已有 content_id 或页无 frontmatter 时返回 null（幂等：调用方据此跳过不写）。
export function addContentIdToFrontmatter(raw, id = newContentId()) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;                              // 无 frontmatter（如纯文本片段）→ 不碰
  if (/^content_id:\s*\S/m.test(m[1])) return null; // 已有 → 幂等跳过
  const text = String(raw).replace(/^---\n/, `---\ncontent_id: ${id}\n`);
  return { text, id };
}

// 在注册 zone 中按稳定 id 查真实页面路径。写侧使用时必须要求唯一命中：撞库时宁可 held，
// 也不能把一次更新落到遍历顺序碰巧先遇到的错误页。Dirent 路径不跟随符号链接，避免扫描越出实例。
export function findPagesByContentId(instanceDir, zones, contentId) {
  const wanted = String(contentId ?? '').trim().toLowerCase();
  if (!wanted) return [];
  const found = new Set();

  for (const zone of zones ?? []) {
    if (!zone?.path) continue;
    const rootRel = String(zone.path).replace(/\/$/, '');
    const rootAbs = path.join(instanceDir, rootRel);
    let first;
    try { first = readdirSync(rootAbs, { withFileTypes: true }); }
    catch { continue; }
    const stack = [{ abs: rootAbs, rel: rootRel, entries: first }];
    while (stack.length) {
      const { abs, rel, entries } = stack.pop();
      for (const ent of entries) {
        const childAbs = path.join(abs, ent.name);
        const childRel = path.posix.join(rel.split(path.sep).join('/'), ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          let children;
          try { children = readdirSync(childAbs, { withFileTypes: true }); }
          catch { continue; }
          stack.push({ abs: childAbs, rel: childRel, entries: children });
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          try {
            if (readContentId(readFileSync(childAbs, 'utf8'))?.toLowerCase() === wanted) found.add(childRel);
          } catch { /* 单个坏文件不应阻断其它候选；零/多命中由调用方安全失败 */ }
        }
      }
    }
  }
  return [...found].sort();
}
