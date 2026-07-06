import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEnrollment } from '../src/enroll.js';

let dir, statePath;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'enroll-')); statePath = path.join(dir, 'enroll-state.json'); });

test('mintCode 返回 sbe_ 码，账本只存 hash、无明文', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'hermes-x', trust: 'high', createdBy: 'cc-test' });
  assert.match(code, /^sbe_[0-9a-f]{32}$/);
  const raw = readFileSync(statePath, 'utf8');
  assert.ok(!raw.includes(code) && !raw.includes('sbe_'));
});

test('trust 白名单：primary/任意值拒发', () => {
  const e = createEnrollment({ statePath });
  for (const trust of ['primary', 'admin', '', undefined]) {
    assert.throws(() => e.mintCode({ client: 'a', trust, createdBy: 'cc' }));
  }
});

test('redeem 单次：重放报 used、过期报 expired、未知报 invalid', () => {
  let t = 1000; const e = createEnrollment({ statePath, now: () => t, codeTtlMs: 900_000 });
  const { code } = e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' });
  const { token } = e.redeemCode({ code, ip: '1.1.1.1' });
  assert.match(token, /^sbk_[0-9a-f]{48}$/);
  try { e.redeemCode({ code, ip: 'x' }); assert.fail(); } catch (err) { assert.equal(err.reason, 'used'); }
  const { code: c2 } = e.mintCode({ client: 'b', trust: 'low', createdBy: 'cc' });
  t += 900_001;
  try { e.redeemCode({ code: c2, ip: 'x' }); assert.fail(); } catch (err) { assert.equal(err.reason, 'expired'); }
  try { e.redeemCode({ code: 'sbe_' + 'f'.repeat(32), ip: 'x' }); assert.fail(); } catch (err) { assert.equal(err.reason, 'invalid'); }
});

test('identify：兑换出的 token 可认、吊销即失效、重启（重新 create）仍认', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'a', trust: 'high', createdBy: 'cc' });
  const { token } = e.redeemCode({ code, ip: 'x' });
  assert.deepEqual(e.identify(token), { client: 'a', trust: 'high' });
  const e2 = createEnrollment({ statePath });                       // 模拟重启
  assert.deepEqual(e2.identify(token), { client: 'a', trust: 'high' });
  e2.revoke({ client: 'a' });
  assert.equal(e2.identify(token), null);
});

test('client 唯一性：撞 pending 码/活 token 拒发，吊销后可复用', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' });
  assert.throws(() => e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' }));
  e.redeemCode({ code, ip: 'x' });
  assert.throws(() => e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' }));
  e.revoke({ client: 'a' });
  e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' });        // 不抛
});

test('pending 上限 + 损坏降级（不覆盖损坏文件）', () => {
  const e = createEnrollment({ statePath, maxPendingCodes: 2 });
  e.mintCode({ client: 'a', trust: 'low', createdBy: 'cc' });
  e.mintCode({ client: 'b', trust: 'low', createdBy: 'cc' });
  assert.throws(() => e.mintCode({ client: 'c', trust: 'low', createdBy: 'cc' }));
  writeFileSync(statePath, '{corrupt');
  const bad = createEnrollment({ statePath });
  assert.equal(bad.degraded, true);
  assert.equal(bad.identify('sbk_' + 'a'.repeat(48)), null);
  assert.throws(() => bad.mintCode({ client: 'z', trust: 'low', createdBy: 'cc' }));
  assert.equal(readFileSync(statePath, 'utf8'), '{corrupt');         // 证据保留
});

test('文件不存在 = 空账本且不落文件（fixture 不被污染）', () => {
  const e = createEnrollment({ statePath });
  assert.equal(e.identify('sbk_' + 'a'.repeat(48)), null);
  assert.equal(existsSync(statePath), false);
});

// ── 补充用例（brief 建议：list 形状 / note 透传 / client 非法字符 / 总量封顶 200）───────

test('list() 形状：tokens/codes 各含文档字段、只暴露 hash8、无明文/无全量 hash', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'ledger-shape', trust: 'capture', note: '接入笔记', createdBy: 'cc' });
  e.redeemCode({ code, ip: '9.9.9.9' });
  const { tokens, codes } = e.list();
  assert.equal(tokens.length, 1);
  assert.equal(codes.length, 1);
  const tok = tokens[0];
  for (const k of ['client', 'trust', 'created_at', 'created_by', 'last_used_at', 'revoked_at', 'note', 'hash8']) {
    assert.ok(k in tok, `token 缺字段 ${k}`);
  }
  const cod = codes[0];
  for (const k of ['client', 'trust', 'note', 'created_at', 'created_by', 'expires_at', 'status', 'hash8']) {
    assert.ok(k in cod, `code 缺字段 ${k}`);
  }
  assert.match(tok.hash8, /^[0-9a-f]{8}$/);
  assert.match(cod.hash8, /^[0-9a-f]{8}$/);
  // list() 绝不回吐全量 hash 或凭据明文
  assert.ok(!('hash' in tok) && !('hash' in cod));
  const dump = JSON.stringify(e.list());
  assert.ok(!dump.includes('sbe_') && !dump.includes('sbk_'));
});

test('note 透传：mint 的 note 落进 code 记录并随兑换带进 token', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'noted', trust: 'low', note: 'hermes 的接入码', createdBy: 'cc' });
  assert.equal(e.list().codes[0].note, 'hermes 的接入码');
  e.redeemCode({ code, ip: 'x' });
  assert.equal(e.list().tokens[0].note, 'hermes 的接入码');
  // 缺省 note → null（不是 undefined，落盘可序列化）
  const e2 = createEnrollment({ statePath: path.join(dir, 's2.json') });
  e2.mintCode({ client: 'nonote', trust: 'low', createdBy: 'cc' });
  assert.equal(e2.list().codes[0].note, null);
});

test('client 非法字符/超长拒发，首尾空白 trim 后接受', () => {
  const e = createEnrollment({ statePath });
  for (const bad of ['a b', 'a/b', 'a@b', 'a\tb', 'a:b', 'x'.repeat(65)]) {
    assert.throws(() => e.mintCode({ client: bad, trust: 'low', createdBy: 'cc' }), undefined, `应拒: ${JSON.stringify(bad)}`);
  }
  // 64 字符边界内合法
  e.mintCode({ client: 'x'.repeat(64), trust: 'low', createdBy: 'cc' });
  // 首尾空白 trim 后是合法名
  e.mintCode({ client: '  padded-ok  ', trust: 'low', createdBy: 'cc' });
  assert.ok(e.list().codes.some((c) => c.client === 'padded-ok'));
});

test('总量封顶 200：超出后删最旧的非 pending 码，token 不裁剪', () => {
  const e = createEnrollment({ statePath });
  const N = 210;
  for (let i = 0; i < N; i++) {
    const { code } = e.mintCode({ client: `c${i}`, trust: 'low', createdBy: 'cc' });
    e.redeemCode({ code, ip: 'x' });   // 立即兑换 → 码变 redeemed（非 pending），可被裁剪
  }
  const { tokens, codes } = e.list();
  assert.equal(codes.length, 200);              // 码历史封顶 200
  assert.equal(tokens.length, N);               // token 从不裁剪
  const codeClients = new Set(codes.map((c) => c.client));
  assert.ok(!codeClients.has('c0'), '最旧的码应被裁掉');
  assert.ok(codeClients.has(`c${N - 1}`), '最新的码应保留');
});

// ── Review 修复用例 ─────────────────────────────────────────────────────────

test('identify 落盘节流：高频使用磁盘 last_used_at 至多滞后 1h，不冻结在首次', () => {
  let t = 10 * 3_600_000;                       // 起点远大于 1h，保证首次 identify 即落盘
  const e = createEnrollment({ statePath, now: () => t });
  const { code } = e.mintCode({ client: 'hot', trust: 'low', createdBy: 'cc' });
  const { token } = e.redeemCode({ code, ip: 'x' });
  const diskLastUsed = () => JSON.parse(readFileSync(statePath, 'utf8')).tokens.find((x) => x.client === 'hot').last_used_at;
  const t1 = t;
  e.identify(token);                             // #1：落盘
  assert.equal(diskLastUsed(), t1);
  t += 1_800_000; e.identify(token);             // #2（+30min）：节流窗内，不写盘
  assert.equal(diskLastUsed(), t1);
  t += 1_800_000; e.identify(token);             // #3（+60min）：距上次【落盘】满 1h → 必须再写
  // 旧实现按内存 prev（上次 identify 时间）比较，间隔恒 30min < 1h → 磁盘值永远冻结在 t1
  assert.equal(diskLastUsed(), t1 + 3_600_000);
});

test('redeemCode 返回 token_hash8：与 list() 里该 token 的 hash8 一致；hash8 仍是码 hash（对账 mint）', () => {
  const e = createEnrollment({ statePath });
  const minted = e.mintCode({ client: 'audit', trust: 'low', createdBy: 'cc' });
  const r = e.redeemCode({ code: minted.code, ip: 'x' });
  assert.match(r.token_hash8, /^[0-9a-f]{8}$/);
  assert.equal(r.hash8, minted.hash8);           // 码 hash 保留，供与 mint 事件链路对账
  assert.equal(e.list().tokens.find((x) => x.client === 'audit').hash8, r.token_hash8);
});

test('revoke：返回吊销计数、对不存在对象抛错', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'r1', trust: 'low', createdBy: 'cc' });
  e.redeemCode({ code, ip: 'x' });
  e.mintCode({ client: 'r2', trust: 'low', createdBy: 'cc' });   // 留一枚 pending
  assert.deepEqual(e.revoke({ client: 'r1' }), { revokedTokens: 1, cancelledCodes: 0 });
  assert.deepEqual(e.revoke({ client: 'r2' }), { revokedTokens: 0, cancelledCodes: 1 });
  assert.throws(() => e.revoke({ client: '查无此名' }));
});
