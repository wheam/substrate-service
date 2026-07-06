// M4.8 enrollment 账本：铸一次性码 → 兑换专属可吊销 token，记账 + 吊销。
// 安全边界（docs/03 §9 M4.8 D4/D5）：账本住 volume、实例 git 之外（git pull 是对抗输入，
// 账本进 repo = 伪造件可自铸 token）；code/token 只存 sha256（卷泄漏 ≠ 凭据泄漏）；
// 原子写；文件损坏 = 降级（enrolled 全失效、不覆盖损坏文件、服务不倒），静态 TOKENS_JSON 不受影响。
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const TRUSTS = new Set(['high', 'low', 'capture']);   // channel:primary 不可经 enrollment 发出（D3）
const CLIENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (message, reason) => { const e = new Error(message); if (reason) e.reason = reason; return e; };

export function createEnrollment({ statePath, now = Date.now, codeTtlMs = 900_000, maxPendingCodes = 10 } = {}) {
  let state = { tokens: [], codes: [] };
  let degraded = false;
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); state.tokens ??= []; state.codes ??= []; }
    catch (e) { degraded = true; console.error(`enroll 账本损坏（${statePath}）：${e.message}——enrolled token 全体降级失效，文件保留待人工处理`); }
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
      if (nameTaken(client)) throw fail(`client 名已被占用：${client}（吊销后可复用）`);
      if (pending().length >= maxPendingCodes) throw fail(`未决 enrollment 码已达上限 ${maxPendingCodes}，先 enroll_revoke 清理`);
      const code = 'sbe_' + crypto.randomBytes(16).toString('hex');
      const rec = { hash: sha256(code), client, trust, note: note ?? null, created_at: now(), created_by: createdBy ?? null, expires_at: now() + codeTtlMs, status: 'pending' };
      state.codes.push(rec); persist();
      return { code, expiresAt: rec.expires_at, hash8: rec.hash.slice(0, 8) };
    },
    redeemCode({ code, ip }) {
      guard(); sweep();
      const rec = state.codes.find((c) => c.hash === sha256(String(code ?? '')));
      if (!rec) throw fail('enrollment 码无效', 'invalid');
      if (rec.status === 'redeemed') throw fail('enrollment 码已被使用（若你是合法接入方，这可能意味着码被抢注——请让主人立即吊销）', 'used');
      if (rec.status === 'expired' || now() > rec.expires_at) { rec.status = 'expired'; persist(); throw fail('enrollment 码已过期，请让主人重新铸一枚', 'expired'); }
      const token = 'sbk_' + crypto.randomBytes(24).toString('hex');
      const tokenHash = sha256(token);
      rec.status = 'redeemed'; rec.redeemed_at = now(); rec.redeemed_ip = ip ?? null;
      state.tokens.push({ hash: tokenHash, client: rec.client, trust: rec.trust, note: rec.note, created_at: now(), created_by: rec.created_by, redeemed_ip: ip ?? null, last_used_at: null, revoked_at: null });
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
      const strip = ({ hash, ...rest }) => ({ ...rest, hash8: hash.slice(0, 8) });
      return { tokens: state.tokens.map(strip), codes: state.codes.map(strip) };
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
