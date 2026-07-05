// tier.js — 分层（lossless capture + governed promotion，spec §3.1 / §6.1 / §6.2）共享原语。
// tier 是普通 frontmatter 键（引擎 doctor 对未知键宽容，见 §6.1 前提）——本模块只做文本层的
// 读/写/校验，不引 YAML 依赖（与 content-id.js / acl.js 同族：正则抽固定键）。
//
// 语义：
//   canonical —— 高置信、事实性强：进主检索、默认可见（无 tier 的存量页一律视同 canonical，§6.1 迁移铁律）。
//   candidate —— 价值可疑但不至于拒：落库、低权重、默认检索不含、include=candidate 可查。
//   rejected  —— keeper 判低价值（disposition=forbidden 但非密钥红线）：隔离可查、带旗标、默认检索排除。
//                注意：密钥/凭据红线仍走 inbox.addEntry 真拒、不落盘、不进分层（§7），与本模块无关。
import { stripScalar } from './acl.js';

export const DEFAULT_TIER = 'canonical';
// 模型「决定」里可产出的分层（写路径）：rejected 不由模型判，而是 keeper 判 forbidden(非红线) 后由代码落盘。
export const DECISION_TIERS = new Set(['canonical', 'candidate']);
// 全部分层（读路径可见性）。
export const TIERS = new Set(['canonical', 'candidate', 'rejected']);
// 高→低档位：晋升「不降级」比大小用它（canonical 最高，rejected 最低）。
export const TIER_RANK = { canonical: 2, candidate: 1, rejected: 0 };

// 缺省即 canonical（§6.1：无 tier 视同 canonical）；非法值也归一到 canonical（读侧宽容）。
// 缺陷4：按 YAML 标量语义归一——先 trim（吃掉 `tier:` 后残留空格），再剥一层引号（复用 acl.stripScalar），
// 再 trim + lowercase。故 `tier: "candidate"` / `'CANDIDATE'` / `  candidate  ` 与裸 candidate 同解。
export function normTier(t) {
  const s = stripScalar(String(t ?? '').trim()).toLowerCase();
  return TIERS.has(s) ? s : DEFAULT_TIER;
}

// 从页/件原文读 tier（只认首个 frontmatter 块；无则 canonical）。归一交给 normTier（引号/大小写/空格无关）。
export function readTier(raw) {
  const fm = String(raw).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const t = fm.match(/^tier:\s*(.+)$/m)?.[1];
  return t != null ? normTier(t) : DEFAULT_TIER;
}

// 从页/件原文读 status（首个 frontmatter 块；无则 ''）。与 readTier 同族：正则抽固定键、YAML 标量归一（去引号/小写）。
export function readStatus(raw) {
  const fm = String(raw).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const s = fm.match(/^status:\s*(.+)$/m)?.[1];
  return s != null ? stripScalar(s.trim()).toLowerCase() : '';
}

// 隔离-rejected 判定（缺陷1/2 共享的单一实现，index 入索引特例与 search 放行特例两面共用，杜绝再分叉）：
// 一个 inbox 件仅当 status:rejected 且 tier:rejected【双条件同时】成立，才是「隔离可查」的 rejected 件
// （默认检索排除、include=rejected + 高信任可查）。pending/held（任何 tier 组合），以及手写的
// status:pending + tier:rejected 残留，一律不满足 → index/search 两面在任何档任何信任都命不中。
export function isQuarantineRejected(raw) {
  return readTier(raw) === 'rejected' && readStatus(raw) === 'rejected';
}

// frontmatter 里是否已有显式 tier 行（区分「无 tier（隐式 canonical）」与「tier: canonical」——
// merge_into 据此决定是否给存量 canonical 页凭空加行）。
export function hasExplicitTier(raw) {
  const fm = String(raw).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return /^tier:\s*.+$/m.test(fm);
}

// 在首个 frontmatter 块内 upsert `tier: X`（有则替换、无则插在 content_id 之后或块首）。
// 编辑严格限定在 frontmatter 块内，正文里巧合的 `tier:` 行不受影响。无 frontmatter 不碰、原样返回。
export function setTierLine(raw, tier) {
  const s = String(raw);
  const m = s.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return s;
  let fm = m[2];
  if (/^tier:\s*.+$/m.test(fm)) fm = fm.replace(/^tier:\s*.+$/m, `tier: ${tier}`);
  else if (/^content_id:\s*.+$/m.test(fm)) fm = fm.replace(/^(content_id:\s*.+)$/m, `$1\ntier: ${tier}`);
  else fm = `tier: ${tier}\n${fm}`;
  return m[1] + fm + m[3] + s.slice(m[0].length);
}

// 读侧 include 归一化：接受数组或逗号串，返回去重后的合法「附加分层」（canonical 恒含、不在此列）。
export function normalizeInclude(include) {
  const arr = Array.isArray(include)
    ? include
    : typeof include === 'string' ? include.split(',') : [];
  const out = [];
  for (const x of arr) {
    const t = String(x).trim();
    if ((t === 'candidate' || t === 'rejected') && !out.includes(t)) out.push(t);
  }
  return out;
}
