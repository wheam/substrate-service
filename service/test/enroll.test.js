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

test('note/createdBy 写读约束一致：超长在 mintCode 落盘前截断，重启（重新 create）不 degraded', () => {
  const e = createEnrollment({ statePath });
  e.mintCode({ client: 'a', trust: 'low', note: 'x'.repeat(501), createdBy: 'y'.repeat(201) });
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(persisted.codes[0].note.length <= 500, 'note 落盘前截断到 ≤500');
  assert.ok(persisted.codes[0].created_by.length <= 200, 'created_by 落盘前截断到 ≤200');
  // 重启：同 statePath 重新 create → validState 通过、账本可用（不因超长 note 判 degraded）
  const e2 = createEnrollment({ statePath });
  assert.equal(e2.degraded, false, '写读约束一致 → reload 不 degraded');
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

// ── Codex 对抗 review 修复用例 ──────────────────────────────────────────────

test('cancelled 码不可兑换：revoke 掉的码报 invalid；同名重铸后旧码仍 invalid、新码可兑且只产一把 token', () => {
  const e = createEnrollment({ statePath });
  const { code: old } = e.mintCode({ client: 'dup', trust: 'low', createdBy: 'cc' });
  assert.deepEqual(e.revoke({ client: 'dup' }), { revokedTokens: 0, cancelledCodes: 1 });
  // Blocker：旧实现只拒 redeemed/expired，cancelled 会落进发 token 分支
  try { e.redeemCode({ code: old, ip: 'x' }); assert.fail('cancelled 码不应兑换成功'); }
  catch (err) { assert.equal(err.reason, 'invalid'); }             // 按 invalid 拒，不泄露它曾存在
  const { code: fresh } = e.mintCode({ client: 'dup', trust: 'low', createdBy: 'cc' });  // 吊销后同名重铸
  try { e.redeemCode({ code: old, ip: 'x' }); assert.fail(); }
  catch (err) { assert.equal(err.reason, 'invalid'); }             // 旧码依然 invalid
  const r = e.redeemCode({ code: fresh, ip: 'x' });                // 新码正常兑换
  assert.equal(r.client, 'dup');
  assert.equal(e.list().tokens.length, 1);                         // 只产生一把 token
});

test('ip 是对抗输入：码明文当 ip 传入不落盘；XFF 取首段；垃圾存 null；IPv6 可存；list() 白名单不透传审计字段', () => {
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'evil-ip', trust: 'low', createdBy: 'cc' });
  e.redeemCode({ code, ip: code });                                // 攻击：把码明文塞进 ip（Task 2 里 ip 来自 x-forwarded-for）
  const raw = readFileSync(statePath, 'utf8');
  assert.ok(!raw.includes(code) && !raw.includes('sbe_'), '状态文件不得含码明文');
  assert.ok(!JSON.stringify(e.list()).includes('sbe_'), 'list() 输出不得含码明文');
  assert.ok(!('redeemed_ip' in e.list().tokens[0]), 'list() 白名单：redeemed_ip 留盘不出面');
  const diskIp = (client) => JSON.parse(readFileSync(statePath, 'utf8')).tokens.find((t) => t.client === client).redeemed_ip;
  const { code: c2 } = e.mintCode({ client: 'xff', trust: 'low', createdBy: 'cc' });
  e.redeemCode({ code: c2, ip: '1.2.3.4, 10.0.0.1' });             // XFF 多跳：只取第一段
  assert.equal(diskIp('xff'), '1.2.3.4');
  const { code: c3 } = e.mintCode({ client: 'junk', trust: 'low', createdBy: 'cc' });
  e.redeemCode({ code: c3, ip: 'not-an-ip' });
  assert.equal(diskIp('junk'), null);                              // 非法字面量一律 null
  const { code: c4 } = e.mintCode({ client: 'v6', trust: 'low', createdBy: 'cc' });
  e.redeemCode({ code: c4, ip: '::1' });
  assert.equal(diskIp('v6'), '::1');                               // 合法 IPv6 照存
});

test('合法 JSON 但结构损坏 → degraded 不崩：tokens 非数组 / trust 越白名单 / hash 非 hex / status 越白名单', () => {
  const cases = [
    JSON.stringify({ tokens: {}, codes: [] }),                     // 顶层结构坏（旧实现在 persistedAt 构造处 TypeError）
    JSON.stringify({ tokens: [{ hash: 'a'.repeat(64), client: 'x', trust: 'admin', revoked_at: null }], codes: [] }),
    JSON.stringify({ tokens: [{ hash: 'Z'.repeat(64), client: 'x', trust: 'low', revoked_at: null }], codes: [] }),
    JSON.stringify({ tokens: [], codes: [{ hash: 'b'.repeat(64), client: 'x', trust: 'low', status: 'weird', expires_at: 0 }] }),
  ];
  for (const [i, content] of cases.entries()) {
    const p = path.join(dir, `bad-${i}.json`);
    writeFileSync(p, content);
    const orig = console.error; console.error = () => {};          // 静音预期内的降级日志
    let bad;
    try { bad = createEnrollment({ statePath: p }); } finally { console.error = orig; }
    assert.equal(bad.degraded, true, `case ${i} 应 degraded`);
    assert.equal(bad.identify('sbk_' + 'a'.repeat(48)), null, `case ${i} identify 应全 null`);
    assert.throws(() => bad.mintCode({ client: 'z', trust: 'low', createdBy: 'cc' }), undefined, `case ${i} 变更应抛错`);
    assert.equal(readFileSync(p, 'utf8'), content, `case ${i} 损坏文件不得被覆盖`);
  }
});

test('损坏日志不回显文件内容（JSON.parse 的 message 会带输入前缀，可能含 sbe_ 片段）', () => {
  writeFileSync(statePath, 'sbe_' + 'f'.repeat(32) + ' not json'); // 明显假码明文开头的损坏内容
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.map(String).join(' '));
  let bad;
  try { bad = createEnrollment({ statePath }); } finally { console.error = orig; }
  assert.equal(bad.degraded, true);
  assert.ok(logs.length >= 1, '降级要有日志信号');
  assert.ok(!logs.join('\n').includes('sbe_'), '日志不得回显文件内容');
});

test('reservedClients：静态 TOKENS_JSON 占用的名字拒发，大小写原样比对', () => {
  const e = createEnrollment({ statePath, reservedClients: ['static-cc', 'Hermes'] });
  assert.throws(() => e.mintCode({ client: 'static-cc', trust: 'low', createdBy: 'cc' }), /静态|TOKENS_JSON/);
  assert.throws(() => e.mintCode({ client: 'Hermes', trust: 'low', createdBy: 'cc' }), /静态|TOKENS_JSON/);
  e.mintCode({ client: 'hermes', trust: 'low', createdBy: 'cc' }); // 原样比对：hermes ≠ Hermes，可发
  assert.ok(e.list().codes.some((c) => c.client === 'hermes'));
});

// ── Codex 复验补漏：validState 字段级校验 ──────────────────────────────────

test('validState 字段级：缺 expires_at 的 pending 码 → degraded（否则 now()>undefined 恒 false = 永不过期码）', () => {
  const content = JSON.stringify({ tokens: [], codes: [{ hash: 'c'.repeat(64), client: 'no-expiry', trust: 'low', status: 'pending', created_at: 1 }] });
  writeFileSync(statePath, content);
  const orig = console.error; console.error = () => {};
  let bad;
  try { bad = createEnrollment({ statePath }); } finally { console.error = orig; }
  assert.equal(bad.degraded, true, '缺 expires_at 应 degraded');
  assert.throws(() => bad.redeemCode({ code: 'sbe_' + 'f'.repeat(32), ip: 'x' }), /损坏/);
  assert.equal(readFileSync(statePath, 'utf8'), content, '文件字节不得变');
});

test('validState 字段级：code 的 client 为对象 → degraded（否则可兑换并流进 list()）', () => {
  const content = JSON.stringify({ tokens: [], codes: [{ hash: 'c'.repeat(64), client: { evil: 1 }, trust: 'low', status: 'pending', created_at: 1, expires_at: 9_000_000_000_000 }] });
  writeFileSync(statePath, content);
  const orig = console.error; console.error = () => {};
  let bad;
  try { bad = createEnrollment({ statePath }); } finally { console.error = orig; }
  assert.equal(bad.degraded, true, 'client 非法类型应 degraded');
  assert.equal(readFileSync(statePath, 'utf8'), content);
});

test('validState 向前兼容：真实写路径产的账本与缺可选键的老账本都不误伤', () => {
  // 真实写路径样本：覆盖 redeemed_ip/redeemed_at、note:null 与 string、created_by 字符串、last_used_at
  const e = createEnrollment({ statePath });
  const { code } = e.mintCode({ client: 'compat', trust: 'high', note: '备注', createdBy: 'cc-static' });
  const { token } = e.redeemCode({ code, ip: '1.2.3.4' });
  e.identify(token);                                               // 写入 last_used_at
  e.mintCode({ client: 'compat2', trust: 'low', createdBy: 'cc' });// 留一枚 pending（note 缺省 null）
  const e2 = createEnrollment({ statePath });
  assert.equal(e2.degraded, false, '自己写的账本不得被误伤');
  assert.deepEqual(e2.identify(token), { client: 'compat', trust: 'high' });
  // 缺可选键（无 redeemed_at/redeemed_ip/last_used_at/note/created_by）的最小老记录：只验类型/值域，不要求字段集
  const p2 = path.join(dir, 'legacy.json');
  writeFileSync(p2, JSON.stringify({
    tokens: [{ hash: 'a'.repeat(64), client: 'legacy-tok', trust: 'low', created_at: 1, revoked_at: null }],
    codes: [{ hash: 'b'.repeat(64), client: 'legacy-code', trust: 'low', status: 'expired', created_at: 1, expires_at: 2 }],
  }));
  const e3 = createEnrollment({ statePath: p2 });
  assert.equal(e3.degraded, false, '缺可选键的老账本不得被误伤');
  assert.equal(e3.list().tokens[0].client, 'legacy-tok');
});
