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
import { validateDecision } from '../src/executor.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function makeInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-remove-'));
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

test('remove_page：keeper 按主人删除意图删页、播报、可从 git 历史找回', async () => {
  const { origin, work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  // SEC-2（审计 B §4 + 二轮加固）：kind=remove 旁路现【额外】要求件是服务端亲生【且未被篡改】（entry.__native，按内容
  // 绑定 token 复算）——inbox 与 keeper 须共享同一个 nativeReg Map（生产 createApp 经 app.locals 同款接线），合法
  // remove 工具经 addEntry 造件才被 keeper 认作 native remove 予以删除。缺此共享则 keeper 看不见 inbox 亲生登记 → 安全失败（held）。
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: work, writer, nativeReg });
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, nativeReg,
    provider: { judge: async () => ({ json: { disposition: 'canonical', zone: 'knowledge', action: 'remove_page', target: 'coffee-brewing', summary: '删除手冲咖啡页', confidence: 0.95 }, model: 'flash', usage: {} }) },
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'remove', content: '把手冲咖啡那页删掉', client: 'cc-test' });
  await r.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1);
  assert.ok(!existsSync(path.join(work, 'knowledge', 'coffee-brewing.md')), '页应被删');
  assert.match(git(origin, 'log', '--oneline', '-2'), /keeper: remove_page/);
  assert.match(messages[0], /✅.*已存|✅.*已删/s);
  // git 历史里还能找回
  const recovered = git(work, 'show', 'HEAD~1:knowledge/coffee-brewing.md');
  assert.match(recovered, /耶加雪菲/);
});

test('remove_page 禁区：governance/skills/inbox 一律校验不过', () => {
  const { work } = makeInstance();
  for (const [zone, target] of [['governance', 'zones'], ['skills', 'keeper/SKILL'], ['inbox', '_x']]) {
    const v = validateDecision({
      instanceDir: work,
      decision: { disposition: 'canonical', zone, action: 'remove_page', target, summary: 's', confidence: 0.99 },
    });
    assert.equal(v.ok, false, `${zone} 应禁删`);
    assert.match(v.reason, /禁删|不存在|不允许/);
  }
});

test('remove_page：目标页不存在 → held 不误删', async () => {
  const { work } = makeInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const keeper = createKeeper({
    instanceDir: work, writer,
    provider: { judge: async () => ({ json: { disposition: 'canonical', zone: 'knowledge', action: 'remove_page', target: 'no-such-page', summary: 's', confidence: 0.95 }, model: 'flash', usage: {} }) },
    notifier: { notify: async () => ({ ok: true }) },
    doctor: false,
  });
  const r = inbox.addEntry({ kind: 'remove', content: '删掉不存在的页', client: 'cc-test' });
  await r.synced;
  const result = await keeper.processPending();
  assert.equal(result.held, 1);
});
