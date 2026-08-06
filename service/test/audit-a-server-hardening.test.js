// audit/2026-07-06 A 组 server 硬化：SEC-1（原型污染免认证）、SEC-4（enrolled-capture 越权读裁）、
// SEC-7（auth_rejected 审计落 raw XFF）。git 支撑的 work 实例（/capture 走单写者 git 提交，需真仓库），
// 仿 capture.test.js；enrollment 面仿 enroll-server.test.js（primary 铸码 → POST /enroll 兑 token）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createEnrollment, sanitizeIp } from '../src/enroll.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
// primary = 主频道（可铸 enrollment 码）；capture = 主人自己的 iOS App（静态、全见全文可裁）；high 对照。
const TOKENS = {
  'static-primary': { client: 'cc-primary', trust: 'high', channel: 'primary' },
  'static-high': { client: 'cc-high', trust: 'high' },
  'static-capture': { client: 'app-ios', trust: 'capture' },
};

let httpServer, baseUrl, work, auditLog;
// enrollment 发的两种 token（third-party）：capture=只投递、high=全权，供 SEC-4 / SEC-1 复用。
let enrolledCaptureToken, enrolledHighToken;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

// 起真端口 + 真 git 仓库（/capture 落 inbox 需单写者 git 提交）
before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-audit-a-'));
  const origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);

  auditLog = [];
  const enrollment = createEnrollment({ statePath: path.join(base, 'enroll-state.json') });
  const app = createApp({ instanceDir: work, tokens: TOKENS, enrollment, audit: (e) => auditLog.push(e) });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // primary 铸两枚码 → 兑成 enrolled token（capture / high）。这是「第三方 agent 自助接入」路径。
  const primary = await mcpClient('static-primary');
  const capCode = extractCode((await primary.callTool({ name: 'enroll_create', arguments: { client: 'third-party-cap', trust: 'capture' } })).content[0].text);
  const highCode = extractCode((await primary.callTool({ name: 'enroll_create', arguments: { client: 'third-party-high', trust: 'high' } })).content[0].text);
  await primary.close();
  enrolledCaptureToken = (await (await postEnroll(capCode)).json()).token;
  enrolledHighToken = (await (await postEnroll(highCode)).json()).token;
  assert.match(enrolledCaptureToken, /^sbk_/);
  assert.match(enrolledHighToken, /^sbk_/);
});

after(() => httpServer?.close());

async function mcpClient(token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

// 裸 POST /mcp（不经 SDK，任意/畸形 token + 自定义头都能塞），返回 Response 供断言状态码。
function rawMcpPost(token, extraHeaders = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token != null ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
}

function postCapture(token, body, extraHeaders = {}) {
  return fetch(`${baseUrl}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token != null ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function getStatus(token) {
  return fetch(`${baseUrl}/capture/status`, { headers: token != null ? { Authorization: `Bearer ${token}` } : {} });
}

function postResolve(token, body) {
  return fetch(`${baseUrl}/capture/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token != null ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function postEnroll(code) {
  return fetch(`${baseUrl}/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

const extractCode = (text) => {
  const m = text.match(/sbe_[0-9a-f]+/);
  assert.ok(m, `响应应含 sbe_ 码：${text}`);
  return m[0];
};

// ==================== SEC-1：原型污染导致免认证访问 ====================
// tokens 是 JSON.parse 出的普通对象：tokens["toString"] 等命中 Object.prototype 上的函数（truthy），
// 旧 `tokens[token] || ...` 把该函数当合法 identity → 免认证。修复后这些 key 一律 401（Object.hasOwn 未命中 + shape 校验）。
const PROTO_KEYS = ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

test('SEC-1：原型链 key 当 Bearer token 打 /mcp 一律 401（不再被当合法 identity）', async () => {
  for (const key of PROTO_KEYS) {
    const res = await rawMcpPost(key);
    assert.equal(res.status, 401, `Bearer ${key} 应 401，实际 ${res.status}`);
  }
});

test('SEC-1：原型链 key 当 Bearer token 打 /capture 一律 401（不得注入 inbox）', async () => {
  for (const key of PROTO_KEYS) {
    const res = await postCapture(key, { text: `原型污染注入 via ${key}` });
    assert.equal(res.status, 401, `Bearer ${key} 打 /capture 应 401，实际 ${res.status}`);
  }
});

test('SEC-1：真实静态 token 仍认证通过（修复不误伤合法凭据）', async () => {
  // /mcp：静态 high initialize 成功（200）
  assert.equal((await rawMcpPost('static-high')).status, 200);
  // /capture：静态 capture 投递成功（200）
  const cap = await postCapture('static-capture', { text: 'SEC-1 合法投递' });
  assert.equal(cap.status, 200);
  assert.equal((await cap.json()).ok, true);
});

test('SEC-1：enrollment 发的 token 仍能认证（shape 校验放行合法两源）', async () => {
  // enrolled high 打 /mcp initialize 成功
  assert.equal((await rawMcpPost(enrolledHighToken)).status, 200);
  // enrolled capture 仍能投 /capture（投递权不受 SEC-1 影响）
  assert.equal((await postCapture(enrolledCaptureToken, { text: 'enrolled 投递' })).status, 200);
});

// ==================== SEC-4：enrolled-capture 越权读全文 + 越权裁定 ====================
// 契约：enrollment 发的 capture = 只投递。当前它能 GET /capture/status 读所有在途件全文 + POST /capture/resolve 裁定。
// 修复：enrolled-capture 只准 POST /capture；status/resolve 一律 403。静态 capture（主人 App）保留全部权。
test('SEC-4：enrolled-capture 可投 /capture（deliver-only 的投递权保留）', async () => {
  const res = await postCapture(enrolledCaptureToken, { text: 'SEC-4 第三方投递' });
  assert.equal(res.status, 200);
  const receipt = await res.json();
  assert.equal(receipt.ok, true);
  const raw = readFileSync(path.join(work, receipt.path), 'utf8');
  assert.match(raw, /admission_trust: capture/);
  assert.match(raw, /admission_source: enrolled/);
  assert.match(raw, /admission_ingress: capture/);
});

test('SEC-4：enrolled-capture 打 GET /capture/status → 403（不得读在途件全文）', async () => {
  const res = await getStatus(enrolledCaptureToken);
  assert.equal(res.status, 403, `应 403，实际 ${res.status}`);
});

test('SEC-4：enrolled-capture 打 POST /capture/resolve → 403（不得裁定）', async () => {
  // 先用主人静态 capture 投一件拿到真实 id（证明 403 是通道拦截、不是「件不存在」）
  const posted = await (await postCapture('static-capture', { text: 'SEC-4 待裁件' })).json();
  const res = await postResolve(enrolledCaptureToken, { id: posted.id, ruling: '越权裁定' });
  assert.equal(res.status, 403, `应 403，实际 ${res.status}`);
  // 件未被改写（未落 owner_ruling）——入口拦下、未触达 resolveEntry
  assert.ok(!/owner_ruling:/.test(readFileSync(path.join(work, posted.path), 'utf8')), 'enrolled-capture 越权裁定不得落 owner_ruling');
});

test('SEC-4：静态 capture（主人 App）仍全见 status + 可裁定（有意设计不被误伤）', async () => {
  const posted = await (await postCapture('static-capture', { text: 'SEC-4 主人 App 裁定件' })).json();
  // status 全见（含全文）
  const status = await getStatus('static-capture');
  assert.equal(status.status, 200);
  const sj = await status.json();
  assert.ok(sj.pending.some((p) => p.id === posted.id), '主人 App 应见到自己投的件');
  assert.ok(sj.pending.every((p) => typeof p.content === 'string'), 'status 带全文供审阅');
  // resolve 可裁定 → 落 owner_ruling
  const res = await postResolve('static-capture', { id: posted.id, ruling: '这条进待办' });
  assert.equal(res.status, 200, `主人 App 裁定应 200，实际 ${res.status}`);
  assert.match(readFileSync(path.join(work, posted.path), 'utf8'), /owner_ruling: 这条进待办/);
});

// ==================== SEC-7：auth_rejected 审计落 raw XFF（未过 sanitizeIp）====================
// /mcp、/capture 的 401 分支审计 ip 用裸 x-forwarded-for，攻击者可塞任意串/换行注入审计行。
// 修复：过 sanitizeIp——列表取首段、非法值落 null。
test('SEC-7：未认证 /mcp 的 auth_rejected 审计 ip 过 sanitizeIp（列表取首段、丢注入尾）', async () => {
  const from = auditLog.length;
  // XFF 首段是合法 IP，尾段是注入 marker——sanitizeIp 应只取首段、丢掉尾段
  await rawMcpPost(null, { 'x-forwarded-for': '8.8.8.8, mcp-inject-marker' });
  const entry = auditLog.slice(from).find((e) => e.event === 'auth_rejected');
  assert.ok(entry, '应记 auth_rejected');
  assert.equal(entry.ip, '8.8.8.8', 'ip 应为首段合法 IP（sanitizeIp 取首段）');
  assert.ok(!JSON.stringify(auditLog.slice(from)).includes('mcp-inject-marker'), '审计不得含注入尾段');
});

test('SEC-7：未认证 /capture 的 auth_rejected 审计 ip 过 sanitizeIp（非法值落 null）', async () => {
  const from = auditLog.length;
  // 整个 XFF 是非法 IP（含注入 marker）→ sanitizeIp 落 null，绝不原样入审计
  await postCapture(null, { text: 'x' }, { 'x-forwarded-for': 'capture-inject-marker-not-ip' });
  const entry = auditLog.slice(from).find((e) => e.event === 'auth_rejected' && e.path === '/capture');
  assert.ok(entry, '应记 /capture 的 auth_rejected');
  assert.equal(entry.ip, null, '非法 XFF → ip 落 null');
  assert.ok(!JSON.stringify(auditLog.slice(from)).includes('capture-inject-marker-not-ip'), '审计不得含非法 XFF 原文');
});

test('SEC-7：换行注入的收口在 sanitizeIp（fetch 不让塞裸换行，直接对函数断言唯一闸门）', () => {
  // server 两处 401 分支用的就是这【同一实现】——含换行/垃圾 → null，合法列表取首段。
  assert.equal(sanitizeIp('1.2.3.4\ninjected'), null, '换行注入 → null');
  assert.equal(sanitizeIp('8.8.8.8, mcp-inject-marker'), '8.8.8.8', '合法 IP 列表取首段');
  assert.equal(sanitizeIp('capture-inject-marker-not-ip'), null, '垃圾非 IP → null');
});
