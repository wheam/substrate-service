import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { validateDirectPageTarget } from '../src/direct-write.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = {
  'direct-token': { client: 'codex-main', trust: 'high', channel: 'primary', write_mode: 'direct' },
  'configured-token': { client: 'hermes-main', trust: 'high' },
  'normal-token': { client: 'legacy-agent', trust: 'high' },
};

let origin;
let work;
let httpServer;
let baseUrl;
let auditLog;

function inboxCount() {
  const dir = path.join(work, 'inbox');
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

async function mcpClient(token) {
  const client = new Client({ name: 'direct-write-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-direct-'));
  origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);

  auditLog = [];
  const app = createApp({
    instanceDir: work, tokens: TOKENS, trustedDirectClients: ['hermes-main'], audit: (entry) => auditLog.push(entry),
  });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => httpServer?.close());

test('可信直写授权只下发给显式 high 客户端', async () => {
  const direct = await mcpClient('direct-token');
  assert.match(direct.getInstructions(), /轻治理可信直写/);
  const directSave = (await direct.listTools()).tools.find((tool) => tool.name === 'save');
  assert.match(directSave.description, /已启用轻治理可信直写/);
  assert.ok(directSave.inputSchema.properties.path);
  await direct.close();

  const configured = await mcpClient('configured-token');
  assert.match(configured.getInstructions(), /本连接由 owner 显式授权为 trusted-direct/,
    'TRUSTED_DIRECT_CLIENTS 应能授权 enrolled/static client 名');
  await configured.close();

  const normal = await mcpClient('normal-token');
  assert.doesNotMatch(normal.getInstructions(), /本连接由 owner 显式授权为 trusted-direct/);
  const normalSave = (await normal.listTools()).tools.find((tool) => tool.name === 'save');
  assert.match(normalSave.description, /未启用可信直写/);
  await normal.close();
});

test('无 provider：明确路径可 create → append 直接提交，且不产生 inbox 件', async () => {
  const beforeInbox = inboxCount();
  const client = await mcpClient('direct-token');
  const created = await client.callTool({
    name: 'save',
    arguments: { content: '轻治理模式试用结论：普通页允许可信直写。', path: 'knowledge/light-governance.md', mode: 'create' },
  });
  assert.notEqual(created.isError, true, created.content?.[0]?.text);
  assert.match(created.content[0].text, /已可信直写/);
  let raw = readFileSync(path.join(work, 'knowledge/light-governance.md'), 'utf8');
  assert.match(raw, /source_agent: codex-main/);
  assert.match(raw, /sources: \[direct-write /);
  const contentId = raw.match(/^content_id: ([0-9a-f]{8})$/m)?.[1];
  assert.ok(contentId);

  const appended = await client.callTool({
    name: 'save',
    arguments: {
      content: '补充：目标不明确时仍退回 inbox。', path: 'knowledge/light-governance.md',
      mode: 'append', expected_content_id: contentId,
    },
  });
  assert.notEqual(appended.isError, true, appended.content?.[0]?.text);
  raw = readFileSync(path.join(work, 'knowledge/light-governance.md'), 'utf8');
  assert.match(raw, /可信直写/);
  assert.match(raw, /目标不明确时仍退回 inbox/);
  assert.equal(inboxCount(), beforeInbox);
  assert.match(git(origin, 'log', '--oneline', '-5'), /direct: append knowledge\/light-governance\.md/);
  await client.close();

  const audits = auditLog.filter((entry) => entry.event === 'direct_write' && entry.ok === true);
  assert.equal(audits.length, 2);
  assert.ok(audits.every((entry) => entry.write_route === 'direct'));
  assert.ok(audits.every((entry) => entry.args.content?.redacted === true));
});

test('可信客户端不传 path/mode 时保持旧 save → inbox 行为', async () => {
  const client = await mcpClient('direct-token');
  const result = await client.callTool({ name: 'save', arguments: { content: '这个目标需要 Keeper 帮忙判断。', hint: '随笔' } });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /已受理.*inbox\//s);
  await client.close();
});

test('未授权客户端不能通过新增参数绕过 inbox', async () => {
  const client = await mcpClient('normal-token');
  const result = await client.callTool({
    name: 'save', arguments: { content: '不应落盘', path: 'knowledge/not-authorized.md', mode: 'create' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DIRECT_NOT_ENABLED/);
  assert.equal(existsSync(path.join(work, 'knowledge/not-authorized.md')), false);
  await client.close();
});

test('可信直写 fail closed：拒绝 Skill/结构页/typed zone/模式冲突/旧 content_id/凭据', async () => {
  const client = await mcpClient('direct-token');
  const cases = [
    [{ content: 'x', path: 'skills/_incoming/x/SKILL.md', mode: 'create' }, /DIRECT_ZONE_DENIED/],
    [{ content: 'x', path: 'knowledge/README.md', mode: 'append' }, /DIRECT_STRUCTURE_DENIED/],
    [{ content: 'x', path: 'todo/owner.md', mode: 'append' }, /DIRECT_ZONE_DENIED/],
    [{ content: 'x', path: 'knowledge/light-governance.md', mode: 'create' }, /DIRECT_CREATE_CONFLICT/],
    [{ content: 'x', path: 'knowledge/missing-direct.md', mode: 'append' }, /DIRECT_APPEND_MISSING/],
    [{ content: 'x', path: 'knowledge/light-governance.md', mode: 'append', expected_content_id: 'deadbeef' }, /DIRECT_CONTENT_ID_MISMATCH/],
    [{ content: 'token ghp_abcdefghij1234567890abcd', path: 'knowledge/secret.md', mode: 'create' }, /DIRECT_CREDENTIAL/],
  ];
  for (const [args, expected] of cases) {
    const result = await client.callTool({ name: 'save', arguments: args });
    assert.equal(result.isError, true, `本例应拒绝：${JSON.stringify(args)}`);
    assert.match(result.content[0].text, expected);
  }
  await client.close();
});

test('doctor 失败时回滚直写，不留下半页或提交', async () => {
  const doctorPath = path.join(work, 'skills/substrate-doctor/doctor.py');
  const original = readFileSync(doctorPath, 'utf8');
  writeFileSync(doctorPath, '#!/usr/bin/env python3\nprint("→ 1 error(s)")\n');
  git(work, 'add', 'skills/substrate-doctor/doctor.py');
  git(work, 'commit', '-m', 'test: force doctor failure');
  git(work, 'push');
  const beforeHead = git(work, 'rev-parse', 'HEAD').trim();

  const client = await mcpClient('direct-token');
  const result = await client.callTool({
    name: 'save', arguments: { content: 'doctor 应拦下这页', path: 'knowledge/doctor-rollback.md', mode: 'create' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DIRECT_DOCTOR_FAILED/);
  assert.equal(existsSync(path.join(work, 'knowledge/doctor-rollback.md')), false);
  assert.equal(git(work, 'rev-parse', 'HEAD').trim(), beforeHead);
  assert.equal(git(work, 'status', '--porcelain').trim(), '');
  await client.close();

  writeFileSync(doctorPath, original);
  git(work, 'add', 'skills/substrate-doctor/doctor.py');
  git(work, 'commit', '-m', 'test: restore doctor');
  git(work, 'push');
});

test('路径校验不跟随 zone 内父目录符号链接', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-direct-path-'));
  cpSync(fixtureDir, dir, { recursive: true });
  symlinkSync(tmpdir(), path.join(dir, 'knowledge', 'outside'));
  assert.throws(
    () => validateDirectPageTarget({ instanceDir: dir, page: 'knowledge/outside/escape.md', mode: 'create' }),
    /DIRECT_PATH_SYMLINK/,
  );
});
