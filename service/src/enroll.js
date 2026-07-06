// M4.8 enrollment 账本：铸一次性码 → 兑换专属可吊销 token，记账 + 吊销。
// 安全边界（docs/03 §9 M4.8 D4/D5）：账本住 volume、实例 git 之外（git pull 是对抗输入，
// 账本进 repo = 伪造件可自铸 token）；code/token 只存 sha256（卷泄漏 ≠ 凭据泄漏）；
// 原子写；文件损坏 = 降级（enrolled 全失效、不覆盖损坏文件、服务不倒），静态 TOKENS_JSON 不受影响。
// 完整性裁定（Codex Major#2 记录在案）：账本完整性依赖 volume 非对抗——能写卷者已可改代码/环境，
// 即全盘沦陷，与 nightly-state 同信任域；load 时的结构校验是纵深防御（防误写/半写坏账），不是密码学边界。
import crypto from 'node:crypto';
import net from 'node:net';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const TRUSTS = new Set(['high', 'low', 'capture']);   // channel:primary 不可经 enrollment 发出（D3）
const CODE_STATUSES = new Set(['pending', 'redeemed', 'expired', 'cancelled']);
const CLIENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (message, reason) => { const e = new Error(message); if (reason) e.reason = reason; return e; };

// 兑换方可控输入的规范化（Codex Blocker#2）：ip 在 server 侧来自 x-forwarded-for，攻击者可放任意
// 字节（包括码明文）——原样入账 = 状态文件被灌可控内容、还可能经 list() 出面。只收合法 IP 字面量：
// XFF 取第一段、trim、node:net.isIP 验过才存，否则一律 null；45 = IPv6（含 IPv4-mapped）最大长度。
// export（Task 2 双审 Blocker#1）：server 层 /enroll 端点也要用这【同一实现】把 raw XFF 收口后再进 audit——
// raw XFF 是兑换方可控，能塞 code/token 明文或换行注入污染审计行。单一实现避免两处漂移。
export const sanitizeIp = (raw) => {
  const first = String(raw ?? '').split(',')[0].trim();
  return first.length <= 45 && net.isIP(first) ? first : null;
};

// 结构校验（Codex Major#3 + 复验补漏）：JSON.parse 过了不等于账本可用——{"tokens":{}} 这类「合法
// JSON 但结构坏」会在后续数组操作处炸掉进程；字段级坏值同样危险：缺 expires_at 的 pending 码令
// now() > undefined 恒 false = 永不过期码，client 塞对象能一路流进 list()。任何一条不合格与 parse
// 失败同路径：degraded、不覆盖文件、服务不倒。
// 向前兼容原则：只验类型/值域、不要求字段集白名单——缺可选键（JSON 缺键读出 undefined）的老账本不误伤。
const optInt = (v) => v == null || Number.isSafeInteger(v);                      // 可选时间戳：null/缺键 或 safe int
const optStr = (v, max) => v == null || (typeof v === 'string' && v.length <= max);
// created_by 是铸码方 client 名，静态 TOKENS_JSON 的名字不受 CLIENT_RE 约束——只验 string 类型+长度
const validState = (s) =>
  Array.isArray(s?.tokens) && Array.isArray(s?.codes)
  && s.tokens.every((t) => t && HASH_RE.test(t.hash ?? '') && TRUSTS.has(t.trust) && CLIENT_RE.test(t.client ?? '')
    && Number.isSafeInteger(t.created_at) && optInt(t.last_used_at) && optInt(t.revoked_at)
    && optStr(t.note, 500) && optStr(t.created_by, 200) && optStr(t.redeemed_ip, 45))
  && s.codes.every((c) => c && HASH_RE.test(c.hash ?? '') && TRUSTS.has(c.trust) && CODE_STATUSES.has(c.status)
    && CLIENT_RE.test(c.client ?? '') && Number.isSafeInteger(c.created_at) && Number.isSafeInteger(c.expires_at)
    && optStr(c.note, 500) && optStr(c.created_by, 200) && optInt(c.redeemed_at) && optStr(c.redeemed_ip, 45));

export function createEnrollment({ statePath, now = Date.now, codeTtlMs = 900_000, maxPendingCodes = 10, reservedClients = [] } = {}) {
  let state = { tokens: [], codes: [] };
  let degraded = false;
  if (existsSync(statePath)) {
    try {
      const loaded = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!validState(loaded)) throw fail('结构校验不过');
      state = loaded;
    } catch {
      // 日志刻意不带 parse 错误 message（Codex Minor#4）：JSON.parse 的 message 会回显文件前缀，
      // 损坏内容可能含 sbe_/sbk_ 片段——降级信号只打路径 + 固定文案。
      degraded = true;
      console.error(`enroll 账本损坏或结构不合格（${statePath}）——enrolled token 全体降级失效，文件保留待人工处理`);
    }
  }
  const persist = () => {
    const tmp = path.join(path.dirname(statePath), `.enroll-state.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, statePath);
  };
  // identify 落盘节流的进程内账（hash → last_used_at 上次真正写盘的时间，本身不落盘）：
  // 节流基准必须是「上次写盘时间」而非「上次内存值」——按内存 prev 比较的话，高频（间隔 <1h）
  // token 每次都把 prev 推新、永远差不满 1h，磁盘 last_used_at 会冻结在重启后第一次使用。
  // load 时用磁盘 last_used_at 打底；运行期兑换出的新 token 不在账上（?? 0 → 首次 identify 即写）。
  const persistedAt = new Map(state.tokens.map((t) => [t.hash, t.last_used_at ?? 0]));
  const reserved = new Set(reservedClients);   // 静态 TOKENS_JSON 的 client 名（Task 2 传入），enrollment 不得撞
  const guard = () => { if (degraded) throw fail('enrollment 账本损坏，已降级只读——请人工检查 enroll-state.json'); };
  const liveTokens = () => state.tokens.filter((t) => !t.revoked_at);
  const pending = () => state.codes.filter((c) => c.status === 'pending');
  const sweep = () => {   // 过期 pending 标记 + 历史封顶（账本兼审计史，别无限膨胀）
    for (const c of pending()) if (now() > c.expires_at) c.status = 'expired';
    const overflow = state.codes.length - 200;
    if (overflow > 0) state.codes = state.codes.filter((c, i) => c.status === 'pending' || i >= overflow);
  };
  const nameTaken = (client) => liveTokens().some((t) => t.client === client) || pending().some((c) => c.client === client);

  return {
    get degraded() { return degraded; },
    mintCode({ client, trust, note, createdBy }) {
      guard(); sweep();
      client = String(client ?? '').trim();
      if (!CLIENT_RE.test(client)) throw fail('client 名不合法（1-64 位，A-Za-z0-9._-）');
      if (!TRUSTS.has(trust)) throw fail(`trust 只能是 high/low/capture（channel:primary 不经 enrollment 发出）`);
      if (reserved.has(client)) throw fail(`client 名已被静态 TOKENS_JSON 占用：${client}`);
      if (nameTaken(client)) throw fail(`client 名已被占用：${client}（吊销后可复用）`);
      if (pending().length >= maxPendingCodes) throw fail(`未决 enrollment 码已达上限 ${maxPendingCodes}，先 enroll_revoke 清理`);
      // 写读约束一致（Task 2 双审 Minor#4）：validState reload 时要求 note≤500 / created_by≤200，
      // 落盘前就截断——否则超长 note 写得进、下次加载 validState 判不过 → enrolled token 全体 degraded 失效。
      const safeNote = note == null ? null : String(note).slice(0, 500);
      const safeCreatedBy = createdBy == null ? null : String(createdBy).slice(0, 200);
      const code = 'sbe_' + crypto.randomBytes(16).toString('hex');
      const rec = { hash: sha256(code), client, trust, note: safeNote, created_at: now(), created_by: safeCreatedBy, expires_at: now() + codeTtlMs, status: 'pending' };
      state.codes.push(rec); persist();
      return { code, expiresAt: rec.expires_at, hash8: rec.hash.slice(0, 8) };
    },
    redeemCode({ code, ip }) {
      guard(); sweep();
      const rec = state.codes.find((c) => c.hash === sha256(String(code ?? '')));
      if (!rec) throw fail('enrollment 码无效', 'invalid');
      if (rec.status === 'redeemed') throw fail('enrollment 码已被使用（若你是合法接入方，这可能意味着码被抢注——请让主人立即吊销）', 'used');
      // 刻意冗余：sweep() 刚扫过一遍过期，这里对命中记录再测一次——两处各取样一次 now()，防两次取样
      // 之间时钟跳变/翻页边界让过期码溜进发 token 分支。别当重复代码清理（Claude reviewer 备忘#4）。
      if (rec.status === 'pending' && now() > rec.expires_at) rec.status = 'expired';
      if (rec.status === 'expired') { persist(); throw fail('enrollment 码已过期，请让主人重新铸一枚', 'expired'); }
      // 只有 pending 且未过期才发 token（Codex Blocker#1）：cancelled 及任何未知 status 一律按
      // invalid 拒——revoke 过的码不是「过期」也不是「用过」，对外不泄露它曾存在。
      if (rec.status !== 'pending') throw fail('enrollment 码无效', 'invalid');
      const cleanIp = sanitizeIp(ip);
      const token = 'sbk_' + crypto.randomBytes(24).toString('hex');
      const tokenHash = sha256(token);
      rec.status = 'redeemed'; rec.redeemed_at = now(); rec.redeemed_ip = cleanIp;
      state.tokens.push({ hash: tokenHash, client: rec.client, trust: rec.trust, note: rec.note, created_at: now(), created_by: rec.created_by, redeemed_ip: cleanIp, last_used_at: null, revoked_at: null });
      persist();   // 先持久化再返回：返回过的 token 绝不能因崩溃变成「服务不认的孤儿」
      // hash8 = 码的 hash（与 mint 事件链路对账）；token_hash8 = 新 token 的 hash（与 list() 的 token 对上）
      return { token, client: rec.client, trust: rec.trust, hash8: rec.hash.slice(0, 8), token_hash8: tokenHash.slice(0, 8) };
    },
    identify(token) {
      if (degraded) return null;
      const t = liveTokens().find((x) => x.hash === sha256(String(token ?? '')));
      if (!t) return null;
      t.last_used_at = now();   // 内存值每次照常更新，落盘与否只看 persistedAt
      // 落盘节流：每 token 至多每小时写一次（identify 在每个请求热路径上，不能每次都写盘）
      if (t.last_used_at - (persistedAt.get(t.hash) ?? 0) >= 3_600_000) {
        try { persist(); persistedAt.set(t.hash, t.last_used_at); }
        catch (e) { console.error(`enroll 账本 last_used_at 落盘失败（不拦认证，持续出现说明磁盘有恙）：${e.message}`); }
      }
      return { client: t.client, trust: t.trust };
    },
    list() {
      // 显式字段白名单（Codex Blocker#2 之 b）：redeemed_ip/redeemed_at 等审计字段留在文件里、不进
      // 输出面——rest spread 会把未来新增的任何字段自动漏出去，出面字段必须逐个点名。
      return {
        tokens: state.tokens.map((t) => ({ client: t.client, trust: t.trust, created_at: t.created_at, created_by: t.created_by, last_used_at: t.last_used_at, revoked_at: t.revoked_at, note: t.note, hash8: t.hash.slice(0, 8) })),
        codes: state.codes.map((c) => ({ client: c.client, trust: c.trust, note: c.note, created_at: c.created_at, created_by: c.created_by, expires_at: c.expires_at, status: c.status, hash8: c.hash.slice(0, 8) })),
      };
    },
    revoke({ client }) {
      guard(); sweep();
      const toks = liveTokens().filter((t) => t.client === client);
      const codes = pending().filter((c) => c.client === client);
      if (!toks.length && !codes.length) throw fail(`没有可吊销的对象：${client}（静态 TOKENS_JSON 里的 token 请去 Railway 变量面板删）`);
      for (const t of toks) t.revoked_at = now();
      for (const c of codes) c.status = 'cancelled';
      persist();
      return { revokedTokens: toks.length, cancelledCodes: codes.length };
    },
  };
}
