import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-resolve-'));
  const origin = path.join(base, 'origin.git');
  const seedDir = path.join(base, 'seed');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  cpSync(fixtureDir, seedDir, { recursive: true });
  git(seedDir, 'init', '-b', 'main');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '-m', 'seed');
  git(seedDir, 'remote', 'add', 'origin', origin);
  git(seedDir, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, work]);
  return { origin, work };
}

test('listEntries：返回 inbox 全部件与状态', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const a = inbox.addEntry({ kind: 'save', content: '第一条', client: 'cc-test' });
  const b = inbox.addEntry({ kind: 'todo', content: '第二条', client: 'cc-test' });
  await Promise.all([a.synced, b.synced]);
  const { entries } = inbox.listEntries();
  assert.equal(entries.length, 2);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.ok(entries.every((e) => e.status === 'pending'));
  assert.ok(entries.every((e) => e.excerpt.length > 0));
});

test('resolveEntry：写入主人裁定并复位 pending；未知 id 报可读错误', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const r = inbox.addEntry({ kind: 'save', content: '拿不准的内容', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这条进 todo' });
  await resolved.synced;
  const raw = readFileSync(path.join(work, r.path), 'utf8');
  assert.match(raw, /status: pending/);
  assert.match(raw, /owner_ruling: 这条进 todo/);
  assert.throws(() => inbox.resolveEntry({ id: 'nope', ruling: 'x' }), /找不到|nope/);
});

test('keeper：主人裁定进 prompt、按裁定执行、判例自动落 _cases.md', async () => {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const calls = [];
  const provider = {
    judge: async (req) => {
      calls.push(req);
      return {
        json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: '按裁定进待办', confidence: 0.99 },
        model: 'flash', usage: {},
      };
    },
  };
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'save', content: '给猫买磨爪板', client: 'cc-test' });
  await r.synced;
  const resolved = inbox.resolveEntry({ id: r.id, ruling: '这是待办不是知识，进 todo' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.match(calls[0].user, /主人裁定.*进 todo/s, '裁定应进判断材料');
  assert.match(readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /给猫买磨爪板/);
  const cases = readFileSync(path.join(work, 'keeper-feedback', '_cases.md'), 'utf8');
  assert.match(cases, new RegExp(r.id));
  assert.match(cases, /这是待办不是知识/);
  assert.match(git(origin, 'log', '--oneline', '-2'), /keeper/);
});

test('capture 通道的裁定无权触发删页：remove_page 校验直接不过', async () => {
  const { work } = makeInstance();
  const { validateDecision } = await import('../src/executor.js');
  const decision = { disposition: 'canonical', zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing', summary: 's', confidence: 0.99 };
  const viaApp = validateDecision({ instanceDir: work, decision, entry: { ruling_via_trust: 'capture' } });
  assert.equal(viaApp.ok, false);
  assert.match(viaApp.reason, /无权删除|capture/);
  const viaHigh = validateDecision({ instanceDir: work, decision, entry: { ruling_via_trust: 'high' } });
  assert.equal(viaHigh.ok, true, '高信任通道的裁定可删');
});

test('listEntries：正文干净（不含 keeper 注记）、解析 held 人话原因与候选方案', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const r = inbox.addEntry({ kind: 'save', content: '原始内容一句话', client: 'cc-test' });
  await r.synced;
  // 模拟 keeper 置 held + 写候选方案块
  const fs = await import('node:fs');
  const abs = path.join(work, r.path);
  let raw = fs.readFileSync(abs, 'utf8').replace(/^status: pending$/m, 'status: held');
  raw += `\n---\n**keeper held**（2026-07-05T02:00:00Z）：local-only 在服务端无意义；keeper 决定 {"zone":"memory"}\n`;
  raw += `\n<!--keeper-options\n${JSON.stringify({ options: [
    { label: '存为临时旅行记忆（过期不保留）', decision: { disposition: 'canonical', zone: 'memory', action: 'merge_into', target: 'platforms-devices-and-smart-home', summary: 's1', confidence: 0.9 } },
    { label: '扔掉别存', decision: { disposition: 'forbidden', zone: 'memory', action: 'merge_into', target: 'x', summary: 's2', confidence: 0.9, reject_reason: '主人选择不保存' } },
  ] })}\n-->\n`;
  fs.writeFileSync(abs, raw);
  const e = inbox.listEntries().entries.find((x) => x.id === r.id);
  assert.equal(e.content, '原始内容一句话', '正文不应包含 keeper 注记与候选块');
  assert.match(e.reason, /local-only 在服务端无意义/);
  assert.ok(!e.reason.includes('{'), '人话原因不应带原始 JSON');
  assert.equal(e.options.length, 2);
  assert.equal(e.options[0].label, '存为临时旅行记忆（过期不保留）');

  // 选项裁定：resolveEntry({option:0}) → owner_ruling=label + 预批决定块
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const after = fs.readFileSync(abs, 'utf8');
  assert.match(after, /status: pending/);
  assert.match(after, /owner_ruling: 存为临时旅行记忆/);
  assert.match(after, /<!--owner-decision/);
});

test('keeper：预批决定直接执行不再重判；held 时自动生成候选方案块并在通知里列出', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const calls = [];
  const provider = {
    judge: async (req) => {
      calls.push(req);
      if (req.mode === 'options') {
        return { json: { options: [
          { label: '方案A：进待办', decision: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: 'A', confidence: 0.9 } },
          { label: '方案B：扔掉', decision: { disposition: 'forbidden', zone: 'todo', action: 'todo_add', target: 'owner', summary: 'B', confidence: 0.9, reject_reason: '不保存' } },
        ] }, model: 'pro', usage: {} };
      }
      return { json: { disposition: 'canonical', zone: 'nonexistent', action: 'new_page', target: 'x', summary: 'x', confidence: 0.99 }, model: 'flash', usage: {} };
    },
  };
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'save', content: '让主判失败的内容', client: 'cc-test' });
  await r.synced;
  const round1 = await keeper.processPending();
  assert.equal(round1.held, 1);
  const e = inbox.listEntries().entries.find((x) => x.id === r.id);
  assert.equal(e.options.length, 2, 'held 后应带 pro 生成的候选');
  assert.match(messages[0], /方案A：进待办/, '通知应列出候选');

  // 主人点了方案A → 预批决定直接执行（不再调 judge）
  const before = calls.length;
  const resolved = inbox.resolveEntry({ id: r.id, option: 0, via: 'app-ios', viaTrust: 'capture' });
  await resolved.synced;
  const round2 = await keeper.processPending();
  assert.equal(round2.filed, 1);
  assert.equal(calls.length, before, '预批决定不应再调用 LLM');
  const fs2 = await import('node:fs');
  assert.match(fs2.readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /让主判失败的内容/);
});
