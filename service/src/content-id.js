// content_id：页/条目的稳定短 id（8 位 hex，内容无关的随机——初次生成后写进 frontmatter、不再变，扛改名）。
// 索引与（未来的）链接引用它。三处共用：executor 建新页时生成、backfill 给存量页回填、index-store 读它。
// 只做 frontmatter 文本层面的增/读，不引 YAML 依赖——与引擎 doctor / 本服务其它解析同族（正则抽固定键）。
import crypto from 'node:crypto';

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
