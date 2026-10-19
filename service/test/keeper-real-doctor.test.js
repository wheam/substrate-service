// keeper / 可信直写 × 真实 doctor 的集成测试（2026-10-18 事故与审查复现的回归）。
// 桩 doctor 测不到这些交互：既有错误挡无关写入、同一确定性失败反复重判、互相链接的一批页面
// 单件永远过不了门禁、并发收件让排队中的写入被拒。这里把实例里的桩换成真实 doctor/curator。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriter } from '../src/writer.js';
import { createInbox } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { directPageWrite } from '../src/direct-write.js';
import { runDoctorReport } from '../src/doctor-gate.js';
import { testAdmissionForKind } from './helpers/admission.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));
const realDir = fileURLToPath(new URL('./fixture/real-doctor', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}
function commitAll(work, message) {
  git(work, 'add', '-A');
  git(work, 'commit', '-m', message);
  git(work, 'push');
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? (e.name === '.git' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
}

// 用真实 doctor/curator 的健康实例（doctor 0 error）：补齐内容页 frontmatter，根 README 链接全部内容页。
async function realInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-real-doctor-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  cpSync(fixtureDir, work, { recursive: true });
  cpSync(path.join(realDir, 'doctor.py'), path.join(work, 'skills/substrate-doctor/doctor.py'));
  cpSync(path.join(realDir, 'curate.py'), path.join(work, 'skills/substrate-curator/curate.py'));
  const pages = walk(work).filter((f) => f.endsWith('.md') && !f.includes('/skills/') && !f.includes('/governance/')
    && !path.basename(f).startsWith('_') && path.basename(f) !== 'README.md');
  for (const f of pages) {
    let text = readFileSync(f, 'utf8');
    for (const field of ['created', 'updated']) {
      if (!new RegExp(`^${field}:`, 'm').test(text)) text = text.replace(/^---\n/, `---\n${field}: 2026-10-18\n`);
    }
    writeFileSync(f, text);
  }
  writeFileSync(path.join(work, 'README.md'),
    `# synthetic instance\n\n${pages.map((f) => `[[${path.relative(work, f).replace(/\.md$/, '')}]]`).join('\n')}\n`);
  assert.equal((await runDoctorReport(work)).errors, 0, '前提：真实 doctor 下基线 0 error');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  git(work, 'init', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-u', 'origin', 'main');
  return { work, writer: createWriter({ instanceDir: work, syncRetryMs: 0 }) };
}

// 假模型：正文首行写 `PAGE=<stem>`，就在 knowledge 区新建同名页。记录调用次数。
function pageProvider() {
  const calls = [];
  return {
    calls,
    judge: async (req) => {
      calls.push(req);
      const stem = req.user.match(/PAGE=([a-z0-9-]+)/)?.[1] ?? 'fallback';
      return {
        json: {
          disposition: 'canonical', action: 'new_page', zone: 'knowledge', target: stem, title: stem,
          summary: `新建 ${stem}`, confidence: 0.95, links: [],
        },
        model: 'fake', usage: {},
      };
    },
  };
}

function rig(x, { blockedAlertMs = 30 * 60_000 } = {}) {
  const nativeReg = new Map();
  const inbox = createInbox({ instanceDir: x.work, writer: x.writer, nativeReg, admissionProvider: testAdmissionForKind });
  const provider = pageProvider();
  const notices = [];
  const audits = [];
  const keeper = createKeeper({
    instanceDir: x.work, writer: x.writer, nativeReg, provider,
    notifier: { notify: async (t) => { notices.push(t); return { ok: true }; } },
    audit: (a) => audits.push(a), blockedAlertMs,
  });
  const save = async (stem, links = []) => {
    const r = inbox.addEntry({
      kind: 'save', client: 'cc-test',
      content: `PAGE=${stem}\n\n${stem} 的正文。${links.map((l) => `相关：[[${l}]]`).join(' ')}`,
    });
    await r.synced;
    return r;
  };
  return { inbox, keeper, provider, notices, audits, save, nativeReg };
}

const pagePath = (x, stem) => path.join(x.work, 'knowledge', `${stem}.md`);

test('既有断链不再挡无关写入：keeper 归档与可信直写都能落库', async () => {
  const x = await realInstance();
  const page = path.join(x.work, 'knowledge/coffee-brewing.md');
  writeFileSync(page, `${readFileSync(page, 'utf8')}\n相关：[[never-present-page]]\n`);
  commitAll(x.work, 'synthetic pre-existing broken link');
  assert.equal((await runDoctorReport(x.work)).errors, 1);

  const { keeper, save, provider } = rig(x);
  await save('independent-note');
  const r = await keeper.processPending();
  assert.equal(r.filed, 1, JSON.stringify(r));
  assert.ok(existsSync(pagePath(x, 'independent-note')));
  assert.equal(provider.calls.length, 1);

  const direct = await directPageWrite({
    instanceDir: x.work, writer: x.writer, client: 'cc-test', page: 'knowledge/direct-note.md',
    content: '一条可信直写的独立笔记。', mode: 'create',
  });
  assert.equal(direct.route, 'direct');
  // 既有错误仍在（没有被悄悄“修掉”），也没有新增。
  assert.equal((await runDoctorReport(x.work)).errors, 1);
});

test('本次写入新增断链：转 blocked，只判一次模型；库没变化不重试；超时后一轮只发一条合并提醒', async () => {
  const x = await realInstance();
  const { keeper, save, provider, notices, audits } = rig(x, { blockedAlertMs: 0 });
  const a = await save('orphan-a', ['missing-target-a']);
  const b = await save('orphan-b', ['missing-target-b']);
  const first = await keeper.processPending();
  assert.equal(first.held, 2, JSON.stringify(first));
  assert.equal(provider.calls.length, 2, '每件只判一次');
  for (const r of [a, b]) {
    const raw = readFileSync(path.join(x.work, r.path), 'utf8');
    assert.match(raw, /^held_class: blocked$/m);
    assert.match(raw, /^blocked_category: links$/m);
    assert.doesNotMatch(raw, /^retry_count:/m);
    assert.match(raw, /\[\[missing-target-/);
  }
  assert.ok(!existsSync(pagePath(x, 'orphan-a')), '新页已回滚');
  // 合并提醒：两件一条消息（blockedAlertMs=0 → 本轮即提醒）
  assert.equal(notices.length, 1, notices.join('\n---\n'));
  assert.match(notices[0], /2 件收件卡住/);
  assert.match(notices[0], new RegExp(a.path.match(/_[\d-]+-(.+)\.md$/)[1]));

  // 再跑几轮：库没有新提交之外的变化，不再调模型、不再提醒、不再写 Git
  const headBefore = git(x.work, 'rev-parse', 'HEAD');
  for (let i = 0; i < 3; i++) await keeper.processPending();
  assert.equal(provider.calls.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(git(x.work, 'rev-parse', 'HEAD'), headBefore, '重复失败不产生新提交');
  assert.equal(audits.filter((e) => e.held_class === 'blocked').length, 2, '同一失败只记一次 held 审计');

  // 补上缺的页（库有新提交）→ 自动重试，复用缓存计划、不重判
  await directPageWrite({ instanceDir: x.work, writer: x.writer, client: 'cc-test', page: 'knowledge/missing-target-a.md', content: '补上的页。', mode: 'create' });
  const after = await keeper.processPending();
  assert.equal(after.filed, 1, JSON.stringify(after));
  assert.ok(existsSync(pagePath(x, 'orphan-a')));
  assert.equal(provider.calls.length, 2, '重试复用已校验计划');
  assert.equal(notices.filter((t) => /自动重试已停止/.test(t)).length, 0);
});

test('互相链接的一组页面分开提交：单件都过不了门禁，keeper 自动整组落库（2026-10-18 事故形态）', async () => {
  const x = await realInstance();
  const { keeper, save, provider, notices } = rig(x);
  const index = await save('trip-index', ['trip-2024', 'trip-2025']);
  const y24 = await save('trip-2024', ['trip-index', 'trip-2025']);
  const y25 = await save('trip-2025', ['trip-index', 'trip-2024']);
  const lonely = await save('trip-notes', ['trip-index', 'never-arrives']); // 缺一页永远不来：不能拖垮整组

  const r = await keeper.processPending();
  assert.equal(r.grouped, 3, JSON.stringify(r));
  for (const stem of ['trip-index', 'trip-2024', 'trip-2025']) assert.ok(existsSync(pagePath(x, stem)), stem);
  for (const rec of [index, y24, y25]) assert.ok(!existsSync(path.join(x.work, rec.path)), '整组成员收件已清场');
  assert.equal((await runDoctorReport(x.work)).errors, 0, '整组落库后全库 0 error');
  assert.equal(provider.calls.length, 4, '每件只判一次');
  assert.ok(notices.some((t) => /已整组存入 3 件/.test(t)), notices.join('\n---\n'));
  assert.equal(git(x.work, 'status', '--porcelain').trim(), '');

  // 缺页的那件仍 blocked；它链到的 trip-index 已落库，只剩真正缺的 never-arrives
  const raw = readFileSync(path.join(x.work, lonely.path), 'utf8');
  assert.match(raw, /^held_class: blocked$/m);
  const again = await keeper.processPending();
  assert.equal(again.filed, 0);
  const notes = [...readFileSync(path.join(x.work, lonely.path), 'utf8').matchAll(/\*\*keeper held\*\*（[^）]*）：(.*)$/gm)];
  assert.match(notes.at(-1)[1], /-> \[\[never-arrives\]\]/, '最新原因只剩真正缺的页');
  assert.doesNotMatch(notes.at(-1)[1], /-> \[\[trip-index\]\]/);
});

test('批次分两轮到达：先到的件等着，后到的补齐后整组落库', async () => {
  const x = await realInstance();
  const { keeper, save } = rig(x);
  await save('batch-a', ['batch-b']);
  const r1 = await keeper.processPending();
  assert.equal(r1.held, 1);
  assert.equal(r1.grouped, 0);
  await save('batch-b', ['batch-a']);
  const r2 = await keeper.processPending();
  assert.equal(r2.grouped, 2, JSON.stringify(r2));
  assert.ok(existsSync(pagePath(x, 'batch-a')) && existsSync(pagePath(x, 'batch-b')));
});

test('库里有凭据类错误：全局拦截写入、立刻发一条说明；修好后卡住的件自动继续', async () => {
  const x = await realInstance();
  const page = path.join(x.work, 'knowledge/coffee-brewing.md');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, `${original}\n${'gh' + 'p_'}${'A'.repeat(30)}\n`);
  commitAll(x.work, 'synthetic leaked token (external edit)');
  const { keeper, save, provider, notices } = rig(x);
  const r = await save('after-leak');
  await keeper.processPending();
  const raw = readFileSync(path.join(x.work, r.path), 'utf8');
  assert.match(raw, /^blocked_category: system$/m);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /必须人工处理/);
  await keeper.processPending();
  assert.equal(notices.length, 1, '同一问题只提醒一次');

  writeFileSync(page, original);
  commitAll(x.work, 'remove leaked token');
  git(x.work, 'pull');
  const fixed = await keeper.processPending();
  assert.equal(fixed.filed, 1, JSON.stringify(fixed));
  assert.equal(provider.calls.length, 1);
});

test('并发收件不再让排队中的可信直写被“工作树不干净”拒绝', async () => {
  const x = await realInstance();
  const { inbox } = rig(x);
  let release; let started;
  const begun = new Promise((r) => { started = r; });
  const gate = new Promise((r) => { release = r; });
  const blocker = x.writer.transact(async () => { started(); await gate; });
  await begun;
  const queued = directPageWrite({
    instanceDir: x.work, writer: x.writer, client: 'cc-test', page: 'knowledge/queued.md', content: '排队中的直写。', mode: 'create',
  }).then((v) => v, (e) => e);
  const receipt = inbox.addEntry({ kind: 'save', content: '直写排队期间到达的收件。', client: 'cc-test' });
  release();
  await blocker;
  const result = await queued;
  await receipt.synced;
  assert.equal(result instanceof Error ? result.message : result.route, 'direct');
  assert.ok(existsSync(path.join(x.work, receipt.path)), '收件保留');
  assert.equal(git(x.work, 'status', '--porcelain').trim(), '');
});
