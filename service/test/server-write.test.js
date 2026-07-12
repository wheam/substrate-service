import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const TOKENS = { 'w-high': { client: 'cc-test', trust: 'high' } };

let origin, work, httpServer, baseUrl;
const auditLog = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-srvw-'));
  origin = path.join(base, 'origin.git');
  work = path.join(base, 'work');
  const seedDir = path.join(base, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);

  const app = createApp({ instanceDir: work, tokens: TOKENS, audit: (entry) => auditLog.push(entry) });
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => httpServer?.close());

async function mcpClient(token) {
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

test('save：秒回受理回执，文件落 inbox 且进 git 远端', async () => {
  const client = await mcpClient('w-high');
  const r = await client.callTool({ name: 'save', arguments: { content: '决定：M2 用 DeepSeek 起步', hint: '决定' } });
  assert.notEqual(r.isError, true);
  const m = r.content[0].text.match(/inbox\/[\w.-]+\.md/);
  assert.ok(m, `回执应含 inbox 路径，实际：${r.content[0].text}`);
  assert.ok(existsSync(path.join(work, m[0])));
  assert.match(readFileSync(path.join(work, m[0]), 'utf8'), /DeepSeek 起步/);
  // 等后台同步后远端应有收件提交
  await new Promise((r2) => setTimeout(r2, 800));
  assert.match(git(origin, 'log', '--oneline', '-3'), /inbox: 收件/);
  await client.close();
});

test('todo_add / remember / collections_upsert 各自落件且 kind 正确', async () => {
  const client = await mcpClient('w-high');
  const cases = [
    { tool: 'todo_add', args: { item: '给自行车打气' }, kind: 'kind: todo' },
    { tool: 'remember', args: { fact: '主人喜欢手冲咖啡' }, kind: 'kind: memory' },
    { tool: 'collections_upsert', args: { name: 'restaurants', row: { name: '新餐厅' } }, kind: 'kind: collection' },
  ];
  for (const c of cases) {
    const r = await client.callTool({ name: c.tool, arguments: c.args });
    assert.notEqual(r.isError, true, `${c.tool} 不应报错：${r.content?.[0]?.text}`);
    const m = r.content[0].text.match(/inbox\/[\w.-]+\.md/);
    assert.ok(m);
    assert.match(readFileSync(path.join(work, m[0]), 'utf8'), new RegExp(c.kind));
  }
  await client.close();
});

test('save：密钥红线在写路径生效', async () => {
  const secret = 'ghp_abcdefghij1234567890abcd';
  const client = await mcpClient('w-high');
  const r = await client.callTool({ name: 'save', arguments: { content: `token: ${secret}` } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /拒收/);
  const audit = auditLog.findLast((entry) => entry.tool === 'save' && entry.ok === false);
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit).includes(secret), '被拒的密钥原文不得进入审计');
  assert.deepEqual(audit.args.content, { redacted: true, length: `token: ${secret}`.length });
  await client.close();
});
