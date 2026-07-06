// M4.4 Task 3：审批式夜班 v0——executor merge_pages / scan 三类检出 / maybeRun 节流落件 / 端到端点选执行。
// 手法沿 schema-evolution.test.js：临时 git 实例 + throw-provider（证零 LLM）+ 点选预批通路。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDecision, applyDecision } from '../src/executor.js';
import { createNightly } from '../src/nightly.js';
import { createWriter } from '../src/writer.js';
import { createInbox, parseEntryBody } from '../src/inbox.js';
import { createKeeper } from '../src/keeper.js';
import { createApp } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const fixtureDir = fileURLToPath(new URL('./fixture/instance', import.meta.url));

// 无 git 的实例副本：executor 直调 / scan 只读，不需要提交面
function makeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'substrate-nightly-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function writePage(root, rel, { title, body, tier = null }) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  const fm = [
    '---',
    `title: ${title}`,
    ...(tier ? [`tier: ${tier}`] : []),
    'created: 2026-01-01',
    'updated: 2026-01-01',
    'type: knowledge',
    '---',
    '',
  ].join('\n');
  writeFileSync(path.join(root, rel), fm + body + '\n');
}

// ==================== 组 1：executor merge_pages（直调）====================

const SRC_BODY = '手冲滤杯 V60 的注水手法：中心开始画圈，分三段注水，每段间隔约三十秒，总时长控制在两分半以内。';
const TGT_BODY = '常用手冲参数汇总页：水温、粉水比、研磨度对照，按豆种分节记录。';

function mergeDecision(over = {}) {
  return {
    disposition: 'canonical', action: 'merge_pages', zone: 'knowledge',
    target: 'knowledge/merge-target', source: 'knowledge/merge-source',
    summary: '夜班维护：merge-source 并入 merge-target', confidence: 1,
    ...over,
  };
}

function seedMergePages(dir) {
  writePage(dir, 'knowledge/merge-source.md', { title: '手冲注水手法', body: SRC_BODY });
  writePage(dir, 'knowledge/merge-target.md', { title: '手冲参数汇总', body: TGT_BODY });
}

test('1a merge_pages：无 rulingMarked 一律拒（数据永不触发删页）；owner_ruling 后放行', () => {
  const dir = makeDir();
  seedMergePages(dir);
  // 无裁定：连 kind=maintenance 都不放行（比 remove_page 更严——无 kind 旁路）
  const cold = validateDecision({ instanceDir: dir, decision: mergeDecision(), entry: { kind: 'maintenance' } });
  assert.equal(cold.ok, false, '无裁定应拒');
  assert.match(cold.reason, /裁定/, '拒因点明需主人裁定');
  // F1：主人点选后 keeper 查批准登记表命中 → 置 entry.__ruling_authentic（gate 只认这个，不再信裸 owner_ruling）→ 放行
  const ruled = validateDecision({ instanceDir: dir, decision: mergeDecision(), entry: { kind: 'maintenance', __ruling_authentic: true } });
  assert.equal(ruled.ok, true, `裁定后应放行：${ruled.reason}`);
  assert.equal(ruled.verdict, 'file');
});

test('1b merge_pages：capture 通道的裁定无权触发（与 remove_page 同级——它会删源页）', () => {
  const dir = makeDir();
  seedMergePages(dir);
  const v = validateDecision({
    instanceDir: dir, decision: mergeDecision(),
    // F1：认证 + 通道都来自 keeper 查登记表后置的机器字段（__ruling_trust=registry 里的 viaTrust），不信文件
    entry: { kind: 'maintenance', __ruling_authentic: true, __ruling_trust: 'capture' },
  });
  assert.equal(v.ok, false, 'capture 通道应被拒');
  assert.match(v.reason, /capture|高信任/, '拒因点明通道限权');
});

test('1c merge_pages 执行：源页正文并入目标页带夜班注记、源页被删（curate rm）、整树提交', async () => {
  const dir = makeDir();
  seedMergePages(dir);
  const entry = { kind: 'maintenance', __ruling_authentic: true }; // F1：gate 认证只认 keeper 置的机器字段
  const decision = mergeDecision();
  const v = validateDecision({ instanceDir: dir, decision, entry });
  assert.equal(v.ok, true, v.reason);
  const applied = await applyDecision({ instanceDir: dir, entry, decision, zone: v.zone });
  const tgt = readFileSync(path.join(dir, 'knowledge/merge-target.md'), 'utf8');
  assert.ok(tgt.includes(SRC_BODY), '源页正文并入目标页');
  assert.match(tgt, /\*\*\d{4}-\d{2}-\d{2} 夜班合并\*\*（自 knowledge\/merge-source\.md）：/, '带夜班合并注记与来源');
  assert.match(tgt, /^updated: \d{4}-\d{2}-\d{2}$/m, '目标页 updated 被刷新');
  assert.ok(!existsSync(path.join(dir, 'knowledge/merge-source.md')), '源页删除（经 curate rm 清反链）');
  assert.deepEqual(applied.changedPaths, ['.'], 'rm 改动面不可预知 → 整树提交（沿 removePage 惯例）');
  assert.match(applied.detail, /merge-source[\s\S]*并入[\s\S]*merge-target/, 'detail 说清谁并入谁');
});

test('1d merge_pages tier 沿 mergeInto 不降级：canonical 源并入 candidate 目标 → 目标升 canonical', async () => {
  const dir = makeDir();
  writePage(dir, 'knowledge/merge-source.md', { title: '手冲注水手法', body: SRC_BODY }); // 无 tier=canonical
  writePage(dir, 'knowledge/merge-target.md', { title: '手冲参数汇总', body: TGT_BODY, tier: 'candidate' });
  const entry = { kind: 'maintenance', __ruling_authentic: true }; // F1：gate 认证只认 keeper 置的机器字段
  const decision = mergeDecision();
  const v = validateDecision({ instanceDir: dir, decision, entry });
  await applyDecision({ instanceDir: dir, entry, decision, zone: v.zone });
  const tgt = readFileSync(path.join(dir, 'knowledge/merge-target.md'), 'utf8');
  assert.match(tgt, /^tier: canonical$/m, 'candidate 目标被 canonical 源晋升（分层不降级）');
});

test('1e merge_pages：结构页（README/_ 前缀）当 source 或 target 一律拒', () => {
  const dir = makeDir();
  seedMergePages(dir);
  writePage(dir, 'knowledge/README.md', { title: '索引', body: '| [[merge-target]] | x |' });
  writePage(dir, 'knowledge/_draft.md', { title: '草稿', body: 'x' });
  const entry = { kind: 'maintenance', __ruling_authentic: true }; // F1：gate 认证只认 keeper 置的机器字段
  for (const over of [
    { source: 'knowledge/README' }, { source: 'knowledge/_draft' },
    { target: 'knowledge/README' }, { target: 'knowledge/_draft' },
  ]) {
    const v = validateDecision({ instanceDir: dir, decision: mergeDecision(over), entry });
    assert.equal(v.ok, false, `结构页应拒：${JSON.stringify(over)}`);
    assert.match(v.reason, /结构页/, '拒因点明结构页');
  }
});

test('1f merge_pages：source==target、页不存在、未注册/骨架 zone 一律拒', () => {
  const dir = makeDir();
  seedMergePages(dir);
  const entry = { kind: 'maintenance', __ruling_authentic: true }; // F1：gate 认证只认 keeper 置的机器字段
  const same = validateDecision({ instanceDir: dir, decision: mergeDecision({ source: 'knowledge/merge-target' }), entry });
  assert.equal(same.ok, false, 'source==target 应拒');
  const noSrc = validateDecision({ instanceDir: dir, decision: mergeDecision({ source: 'knowledge/ghost' }), entry });
  assert.equal(noSrc.ok, false, '源页不存在应拒');
  assert.match(noSrc.reason, /不存在/);
  const noTgt = validateDecision({ instanceDir: dir, decision: mergeDecision({ target: 'knowledge/ghost' }), entry });
  assert.equal(noTgt.ok, false, '目标页不存在应拒');
  // inbox 等骨架/流水区：fixture 未注册为 zone → zone 查找先拒；即便未来被注册，NO_DELETE_ZONES 兜底
  const skel = validateDecision({ instanceDir: dir, decision: mergeDecision({ zone: 'inbox', source: 'inbox/x', target: 'inbox/y' }), entry });
  assert.equal(skel.ok, false, '骨架/未注册 zone 应拒');
  const badPath = validateDecision({ instanceDir: dir, decision: mergeDecision({ source: '../escape' }), entry });
  assert.equal(badPath.ok, false, '越界路径应拒');
});

test('1g(F3) merge_pages 原子回滚：curate rm 失败 → target 无半并、源页仍在、抛错含回滚', async () => {
  const dir = makeDir();
  seedMergePages(dir);
  const entry = { kind: 'maintenance', __ruling_authentic: true };
  const decision = mergeDecision();
  const v = validateDecision({ instanceDir: dir, decision, entry });
  assert.equal(v.ok, true, v.reason);
  const tgtBefore = readFileSync(path.join(dir, 'knowledge/merge-target.md'), 'utf8');
  const srcBefore = readFileSync(path.join(dir, 'knowledge/merge-source.md'), 'utf8');
  // 强制 curate rm 失败：把 vendored curate.py 换成非零退出（模拟 rm 失败/超时）
  writeFileSync(path.join(dir, 'skills', 'substrate-curator', 'curate.py'), 'import sys\nsys.exit(1)\n');
  await assert.rejects(
    () => applyDecision({ instanceDir: dir, entry, decision, zone: v.zone }),
    /回滚/, '失败应抛错且含回滚意味',
  );
  assert.equal(readFileSync(path.join(dir, 'knowledge/merge-target.md'), 'utf8'), tgtBefore, 'target 逐字回滚、无半并残留');
  assert.ok(existsSync(path.join(dir, 'knowledge/merge-source.md')), '源页仍在（未被半删）');
  assert.equal(readFileSync(path.join(dir, 'knowledge/merge-source.md'), 'utf8'), srcBefore, '源页内容原样');
});

test('1h(G3) merge_pages 整树 git 回滚：curate rm 改了第三方页反链后失败 → 第三方页也回滚、工作树干净', async () => {
  const { work } = makeGitInstance();
  // 源/目标/第三方页（第三方页反链引用源页）都提交进 git——git checkout 才有 HEAD 可回滚到
  seedCommit(work, (w) => {
    seedMergePages(w);
    writePage(w, 'knowledge/third-party.md', { title: '第三方页', body: '参考手冲注水手法。\n\n相关：[[merge-source]]' });
  });
  const entry = { kind: 'maintenance', __ruling_authentic: true };
  const decision = mergeDecision();
  const v = validateDecision({ instanceDir: work, decision, entry });
  assert.equal(v.ok, true, v.reason);
  const thirdBefore = readFileSync(path.join(work, 'knowledge/third-party.md'), 'utf8');
  const tgtBefore = readFileSync(path.join(work, 'knowledge/merge-target.md'), 'utf8');
  const srcBefore = readFileSync(path.join(work, 'knowledge/merge-source.md'), 'utf8');
  // 失败的 curate stub：先改第三方页反链、再删源页，然后非零退出（模拟 rm 改了别的页才失败）
  writeFileSync(path.join(work, 'skills', 'substrate-curator', 'curate.py'),
    'import sys, pathlib\n'
    + "third = pathlib.Path('knowledge/third-party.md')\n"
    + "third.write_text(third.read_text().replace('[[merge-source]]', '已并入 merge-target'))\n"
    + "src = pathlib.Path('knowledge/merge-source.md')\n"
    + 'src.exists() and src.unlink()\n'
    + 'sys.exit(1)\n');
  await assert.rejects(
    () => applyDecision({ instanceDir: work, entry, decision, zone: v.zone }),
    /回滚/, '失败应抛错且含回滚意味',
  );
  // 整树回滚：第三方页反链、target、源页全部恢复原样，无脏残留（旧码只回滚 source/target → 第三方页脏残留）
  assert.equal(readFileSync(path.join(work, 'knowledge/third-party.md'), 'utf8'), thirdBefore, '第三方页反链回滚原样');
  assert.equal(readFileSync(path.join(work, 'knowledge/merge-target.md'), 'utf8'), tgtBefore, 'target 无半并');
  assert.ok(existsSync(path.join(work, 'knowledge/merge-source.md')), '源页回滚复现');
  assert.equal(readFileSync(path.join(work, 'knowledge/merge-source.md'), 'utf8'), srcBefore, '源页内容原样');
  // 工作树干净：git checkout 恢复所有 tracked 改动（curate.py 本测替换的改动亦被一并回滚 → 无残留）
  const porcelain = git(work, 'status', '--porcelain').trim();
  assert.equal(porcelain, '', `merge_pages 回滚后工作树 git status 干净：\n${porcelain}`);
});

test('1i(H2) merge_pages 整树回滚排除 inbox：并发的队列外 inbox 批准写不被回滚抹掉（G3 第三方页回滚仍生效）', async () => {
  const { work } = makeGitInstance();
  // 并发件：此前已 held、被 commit 进库（tracked）。resolveEntry 在进 writer 队列前就 writeFileSync 改它
  // （inbox.js 写在前、commit 排队在后）——回滚发生时它是一个 tracked+已改、尚未提交的批准写。curate rm 只改
  // 内容页（source/target/第三方反链），从不碰 inbox；整树 `git checkout -- .` 却会把它抹回 HEAD（丢 owner_ruling
  // 与 status:pending）。修：回滚 checkout 排除 inbox → 并发批准写保住。
  const concurrentRel = 'inbox/_2026-01-01-h2ab.md';
  seedCommit(work, (w) => {
    seedMergePages(w);
    writePage(w, 'knowledge/third-party.md', { title: '第三方页', body: '参考手冲注水手法。\n\n相关：[[merge-source]]' });
    mkdirSync(path.join(w, 'inbox'), { recursive: true });
    writeFileSync(path.join(w, concurrentRel), [
      '---', 'title: 收件 h2ab', 'created: 2026-01-01', 'updated: 2026-01-01', 'type: inbox',
      'id: h2ab', 'received_at: 2026-01-01T00:00:00.000Z', 'client: cc-test', 'kind: save',
      'keeper_held_at: 2026-01-01T00:00:00.000Z', 'status: held', '---', '', '一条并发批准中的件\n',
    ].join('\n'));
  });
  const entry = { kind: 'maintenance', __ruling_authentic: true };
  const decision = mergeDecision();
  const v = validateDecision({ instanceDir: work, decision, entry });
  assert.equal(v.ok, true, v.reason);
  const thirdBefore = readFileSync(path.join(work, 'knowledge/third-party.md'), 'utf8');
  const tgtBefore = readFileSync(path.join(work, 'knowledge/merge-target.md'), 'utf8');
  // 失败的 curate stub：改第三方页反链 + 删源页后非零退出（同 1h 形状，使 mergePages 走整树回滚）
  writeFileSync(path.join(work, 'skills', 'substrate-curator', 'curate.py'),
    'import sys, pathlib\n'
    + "third = pathlib.Path('knowledge/third-party.md')\n"
    + "third.write_text(third.read_text().replace('[[merge-source]]', '已并入 merge-target'))\n"
    + "src = pathlib.Path('knowledge/merge-source.md')\n"
    + 'src.exists() and src.unlink()\n'
    + 'sys.exit(1)\n');
  // 模拟 resolveEntry 的队列外写：回滚发生前把并发件改成 status:pending + owner_ruling（tracked、未提交）
  const concurrentAbs = path.join(work, concurrentRel);
  writeFileSync(concurrentAbs, readFileSync(concurrentAbs, 'utf8')
    .replace(/^status: held$/m, 'owner_ruling: 主人已批准这件\nstatus: pending'));
  await assert.rejects(
    () => applyDecision({ instanceDir: work, entry, decision, zone: v.zone }),
    /回滚/, '失败应抛错且含回滚意味',
  );
  // ① G3 不回退：第三方页反链 / target / 源页照样整树回滚原样（H2 不能破坏 G3 的原修复）
  assert.equal(readFileSync(path.join(work, 'knowledge/third-party.md'), 'utf8'), thirdBefore, '第三方页反链回滚原样（G3 仍生效）');
  assert.equal(readFileSync(path.join(work, 'knowledge/merge-target.md'), 'utf8'), tgtBefore, 'target 无半并');
  assert.ok(existsSync(path.join(work, 'knowledge/merge-source.md')), '源页回滚复现');
  // ② H2：并发的队列外 inbox 批准写未被回滚抹掉（仍带 status:pending + owner_ruling，等它自己的 commit 落定）
  const concurrentAfter = readFileSync(concurrentAbs, 'utf8');
  assert.match(concurrentAfter, /^status: pending$/m, '并发 inbox 件仍为 pending（未被 checkout 抹回 held）');
  assert.match(concurrentAfter, /^owner_ruling: 主人已批准这件$/m, '并发 inbox 件的 owner_ruling 未被抹掉');
});

// ==================== 组 2：scan 三类确定性检出 ====================

// 基线 fixture 的 4 页正文都 <200 字符（天然全是薄页）——垫厚到阈值之上且彼此相异，
// 令基线库零检出，各测试只看本组显式造的页；fixture 原文件不动（其它套件依赖其原文）。
function padFixture(dir) {
  const fillers = {
    'todo/owner.md': '园艺工具保养列表核对完毕，梯子归位车库左侧挂架，喷壶滤网每季度清洗一次，肥料存量在春季前补齐，割草机油量检查安排在周末上午，手套备用两双放在工具箱第二层，防虫网四月前更换新的，浇灌定时器电池顺带换掉，篱笆补漆等雨季结束再排期。',
    'todo/curio-todo.md': '集成回归脚本迁移至新流水线后需要连续观察三个发布周期，报警阈值调优记录归档在运维手册附录，值班轮换表同步给全组成员知晓，容量预估报告每月初刷新一次并抄送平台组，灰度开关清单季度盘点，遗留任务看板每周五收尾核对。',
    'knowledge/coffee-brewing.md': '磨豆机刻度与萃取率的对应关系尚待系统记录，滤纸品牌之间的风味差异属于主观感受仅供参考，水质硬度对酸感的影响相当明显，建议使用过滤水冲煮并定期给电水壶除垢保养，闷蒸时间随烘焙度加深适当缩短，豆仓避光存放开封两周内用完。',
    'memory/about-owner/core-summary.md': '作息偏好早睡早起，工作日午后安排深度专注时段，周末倾向户外徒步与摄影，阅读口味偏非虚构历史类，饮食上尽量避免油炸食品，出行习惯提前规划路线，纪念日提醒提前一周，礼物偏好实用物件而非摆设，聚会场合偏安静的小馆子。',
  };
  for (const [rel, filler] of Object.entries(fillers)) {
    // 同段落重复两遍只为凑过 200 字符阈值（页内重复不影响两两比对），跨页内容彼此相异
    writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8').trimEnd() + `\n\n垫充：${filler}${filler}\n`);
  }
}

// scan 只读，不需要 inbox/notifier；占位即可
function scanOnly(dir) {
  return createNightly({
    instanceDir: dir,
    inbox: null, notifier: null, audit: () => {},
    intervalMs: 0, statePath: path.join(dir, '..', `nightly-state-${path.basename(dir)}.json`),
  });
}

// >200 字符的「厚页」正文样板（薄页阈值以上）
const LONG_A = '冲煮参数的完整记录：水温九十二度，粉水比一比十五，研磨度中细，闷蒸三十秒注水六十克，第二段注水到一百八十克，第三段收尾到二百二十五克，总时长两分三十秒。浅烘豆整体提高两度水温，深烘豆降低三度并放粗研磨。出品偏酸就升温或磨细，出品偏苦就降温或放粗。滤杯用锥形单孔，滤纸提前润湿去纸味，分享壶预热。豆子养豆七到十四天风味最稳定，开封后两周内用完为佳。手冲之外偶尔做法压，粉水比放宽到一比十二，浸泡四分钟压杆，口感更厚重。周末待客用虹吸壶，仪式感强但清洗麻烦。';

test('2a scan 去重：正文前 500 字符 bigram 相似 ≥0.6 检出，正文较长者为保留侧 a', () => {
  const dir = makeDir();
  padFixture(dir);
  writePage(dir, 'knowledge/dup-a.md', { title: '萃取笔记副本', body: LONG_A });
  writePage(dir, 'knowledge/dup-b.md', { title: '冲煮手记存档', body: LONG_A + '补充：夏天冷萃比例一比十二，冷藏十二小时后过滤，稀释后再喝。' });
  const { duplicates } = scanOnly(dir).scan();
  const hit = duplicates.find((d) => d.b === 'knowledge/dup-a.md' || d.a === 'knowledge/dup-a.md');
  assert.ok(hit, `应检出 dup-a/dup-b 相似对：${JSON.stringify(duplicates)}`);
  assert.equal(hit.a, 'knowledge/dup-b.md', '正文较长者为保留侧 a');
  assert.equal(hit.b, 'knowledge/dup-a.md', '较短者为并入侧 b');
  assert.equal(hit.zone, 'knowledge');
  assert.ok(hit.score >= 0.6 && hit.score <= 1, `score 应在 [0.6,1]：${hit.score}`);
});

test('2b scan 去重：标题词集 Jaccard 命中同样算重复；相异页对不误报', () => {
  const dir = makeDir();
  padFixture(dir);
  // 同题异文：标题完全一致（titleJ=1）、正文互不相似 → 仍应检出
  writePage(dir, 'knowledge/gear-x.md', { title: '旅行装备清单', body: '出门必带护照与充电器，相机备两块电池，境外通行的实体卡放钱包夹层，雨衣折叠伞看目的地气候决定，转换插头选全球通用型号，登机箱控制在七公斤以内。'.repeat(3) });
  writePage(dir, 'knowledge/gear-y.md', { title: '旅行装备清单', body: '徒步路线的装备另算：登山杖一对，速干衣两套，水袋两升，能量胶按每小时一支备货，头灯带备用电池，急救包放最外侧口袋，鞋子务必提前磨合两周以上再上长线。'.repeat(3) });
  const { duplicates } = scanOnly(dir).scan();
  assert.ok(duplicates.some((d) => [d.a, d.b].includes('knowledge/gear-x.md') && [d.a, d.b].includes('knowledge/gear-y.md')),
    `同题页对应被检出：${JSON.stringify(duplicates)}`);
  // 相异页（垫厚后的 fixture 页彼此、与 gear 对）不得误报
  assert.ok(!duplicates.some((d) => d.a.includes('coffee-brewing') || d.b.includes('coffee-brewing')), 'coffee-brewing 不应误报');
  assert.ok(!duplicates.some((d) => d.a.startsWith('todo/') || d.b.startsWith('todo/')), 'todo 页不应误报');
});

test('2c scan 薄页：<200 字符检出（200 整不算）；相近页给 mergeCandidate、孤例给 null', () => {
  const dir = makeDir();
  padFixture(dir);
  writePage(dir, 'knowledge/edge-199.md', { title: '丙录', body: '丙'.repeat(199) });
  writePage(dir, 'knowledge/edge-200.md', { title: '乙记', body: '乙'.repeat(200) });
  writePage(dir, 'knowledge/params.md', { title: '手冲参数汇总', body: LONG_A });
  writePage(dir, 'knowledge/thin-buddy.md', { title: '手冲参数速查', body: '速查版：只记水温九十二度与粉水比一比十五两条。' });
  const { thin } = scanOnly(dir).scan();
  const pages = thin.map((t) => t.page);
  assert.ok(pages.includes('knowledge/edge-199.md'), '199 字符应算薄页');
  assert.ok(!pages.includes('knowledge/edge-200.md'), '200 整不算薄页（严格 <200）');
  assert.equal(thin.find((t) => t.page === 'knowledge/edge-199.md').chars, 199, 'chars 如实上报');
  assert.equal(thin.find((t) => t.page === 'knowledge/edge-199.md').mergeCandidate, null, '无相近页 → mergeCandidate null');
  const buddy = thin.find((t) => t.page === 'knowledge/thin-buddy.md');
  assert.ok(buddy, '薄页 thin-buddy 应检出');
  assert.equal(buddy.mergeCandidate, 'knowledge/params.md', '标题相近的大页应成为合并候选');
  assert.ok(!pages.includes('knowledge/params.md'), '厚页不算薄页');
});

test('2d scan 断链：[[stem]] 全库无对应 .md 才报；存在的不报', () => {
  const dir = makeDir();
  padFixture(dir);
  writePage(dir, 'knowledge/linker.md', {
    title: '链接页样例',
    body: `${LONG_A}\n\n相关：[[coffee-brewing]]、[[ghost-page]]`,
  });
  const { brokenLinks } = scanOnly(dir).scan();
  assert.ok(brokenLinks.some((b) => b.page === 'knowledge/linker.md' && b.stem === 'ghost-page'),
    `无对应页的 [[ghost-page]] 应报断链：${JSON.stringify(brokenLinks)}`);
  assert.ok(!brokenLinks.some((b) => b.stem === 'coffee-brewing'), '存在的 [[coffee-brewing]] 不算断链');
});

test('2d-剥码 scan 断链：围栏/行内/缩进代码块里的 [[..]] 示例不误报（对齐 doctor），裸链仍报', () => {
  const dir = makeDir();
  padFixture(dir);
  writePage(dir, 'knowledge/linker-code.md', {
    title: '讲 wikilink 语法的页',
    body: `${LONG_A}\n\n行内示例：\`[[inline-ghost]]\`。\n\n\`\`\`\n[[fenced-ghost]]\n\`\`\`\n\n缩进码块示例：\n\n    [[indented-ghost]]\n\n真正的裸链：[[naked-ghost]]`,
  });
  const stems = scanOnly(dir).scan().brokenLinks
    .filter((b) => b.page === 'knowledge/linker-code.md').map((b) => b.stem);
  assert.ok(stems.includes('naked-ghost'), `裸链 [[naked-ghost]] 仍应报：${JSON.stringify(stems)}`);
  assert.ok(!stems.includes('inline-ghost'), '行内代码里的示例不应误判断链');
  assert.ok(!stems.includes('fenced-ghost'), '代码围栏里的示例不应误判断链');
  assert.ok(!stems.includes('indented-ghost'), '缩进代码块里的示例不应误判断链（对齐 doctor）');
});

test('2e scan 范围裁剪：README/_ 前缀/inbox/governance/keeper-feedback 一律不进扫描', () => {
  const dir = makeDir();
  padFixture(dir);
  // 这些全是「若被扫描必成薄页/断链」的诱饵
  writePage(dir, 'knowledge/README.md', { title: '索引', body: '| [[coffee-brewing]] | 手冲 |' });
  writePage(dir, 'knowledge/_scratch.md', { title: '草稿', body: '[[ghost-page]]' });
  writePage(dir, 'inbox/_2026-01-01-zzz9-beef.md', { title: '收件 zzz9-beef', body: '一条待审收件 [[ghost-page]]' });
  mkdirSync(path.join(dir, 'keeper-feedback'), { recursive: true });
  writePage(dir, 'keeper-feedback/_cases.md', { title: '判例集', body: '判例若干' });
  const { duplicates, thin, brokenLinks } = scanOnly(dir).scan();
  const touched = [
    ...duplicates.flatMap((d) => [d.a, d.b]),
    ...thin.map((t) => t.page),
    ...brokenLinks.map((b) => b.page),
  ];
  for (const p of touched) {
    assert.ok(!p.startsWith('inbox/') && !p.startsWith('governance/') && !p.startsWith('keeper-feedback/') && !p.startsWith('skills/'),
      `骨架/流水区不得进扫描：${p}`);
    assert.ok(path.basename(p) !== 'README.md' && !path.basename(p).startsWith('_'), `结构页不得进扫描：${p}`);
  }
});

// ==================== 组 3：maybeRun 节流 / 落件 / 上限 / 去重 ====================

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

// git 后端实例（addEntry 会 commitAndPush，需真远端）——沿 schema-evolution.test.js 手法，各用例独立 origin
function makeGitInstance() {
  const base = mkdtempSync(path.join(tmpdir(), 'substrate-nightly-git-'));
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
  return { base, work };
}

// 造页后本地提交（writer 后续 push 会连带带上；工作树保持干净）
function seedCommit(work, fn) {
  fn(work);
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'seed pages');
}

function nightlySetup(work, { intervalMs = 604_800_000, statePath } = {}) {
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const messages = [];
  const audits = [];
  const nightly = createNightly({
    instanceDir: work, inbox,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    audit: (e) => audits.push(e),
    intervalMs, ...(statePath ? { statePath } : {}),
  });
  return { writer, inbox, nightly, messages, audits };
}

function maintenanceEntries(work) {
  const dir = path.join(work, 'inbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('_') && f.endsWith('.md'))
    .map((f) => ({ rel: `inbox/${f}`, raw: readFileSync(path.join(dir, f), 'utf8') }))
    .filter((e) => /^kind: maintenance$/m.test(e.raw));
}

test('3a maybeRun 节流：到期跑并写回默认 statePath（实例 git 外）；未到期 no-op；intervalMs=0 永不跑', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, padFixture); // 零检出库：本测只看节流与状态文件
  const { nightly, audits, messages } = nightlySetup(work); // 不传 statePath → 用默认 ../nightly-state.json
  const r1 = await nightly.maybeRun();
  assert.equal(r1.ran, true, '无状态文件 → 视为到期，跑');
  const defaultState = path.resolve(work, '..', 'nightly-state.json');
  assert.ok(existsSync(defaultState), '默认 statePath 落在实例目录之外（与 recall-index 同级惯例）');
  assert.ok(JSON.parse(readFileSync(defaultState, 'utf8')).lastRun, '写回 lastRun');
  assert.equal(audits.filter((e) => e.event === 'nightly_run').length, 1, '跑一轮记一条 nightly_run');
  assert.equal(r1.proposed, 0, '零检出 → 零提案');
  assert.equal(messages.length, 0, '零提案不打扰主人（audit 已作心跳）');
  // 未到期：立即再跑 → no-op
  const r2 = await nightly.maybeRun();
  assert.equal(r2.ran, false, '未到期 no-op');
  assert.equal(audits.filter((e) => e.event === 'nightly_run').length, 1, 'no-op 不记 nightly_run');
  // intervalMs=0 → 禁用：即便没有状态文件也永不跑
  const disabledState = path.join(work, '..', 'nightly-disabled.json');
  const { nightly: off, audits: offAudits } = nightlySetup(work, { intervalMs: 0, statePath: disabledState });
  const r3 = await off.maybeRun();
  assert.equal(r3.ran, false, 'intervalMs=0 永不跑');
  assert.ok(!existsSync(disabledState), '禁用态不写状态文件');
  assert.equal(offAudits.length, 0, '禁用态零审计');
});

// 另一份 >200 字符厚页正文（与 LONG_A 内容全异——防止意外凑成相似对）
const LONG_B = '关于居家网络布线的记录：光猫桥接后由主路由拨号，客厅到书房走六类线，弱电箱里加了散热风扇，交换机选二点五G口，无线回程做备份链路，访客网络与主网隔离，物联网设备单独划分网段。'.repeat(3);

test('3b maybeRun 落件形状：kind/status/client/候选块齐全；断链只报告；提案不搬页正文', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/dup-a.md', { title: '萃取笔记副本', body: LONG_A });
    writePage(w, 'knowledge/dup-b.md', { title: '冲煮手记存档', body: LONG_A + '补充：夏天冷萃比例一比十二，冷藏十二小时后过滤，稀释后再喝。' });
    writePage(w, 'knowledge/params.md', { title: '手冲参数汇总', body: LONG_B });
    // 薄页（标题与 params 相近 → merge 提案）；正文别与 dup 对相似
    writePage(w, 'knowledge/thin-buddy.md', { title: '手冲参数速查', body: '速查版：只记水温九十二度与粉水比一比十五两条。' });
    // 薄页（无相近页 → remove 提案）
    writePage(w, 'knowledge/thin-alone.md', { title: '孤丁残稿', body: '丁'.repeat(60) });
    // 断链页（报告型；自身垫厚过薄页阈值，只贡献断链一类检出）
    writePage(w, 'knowledge/linker.md', { title: '链接页样例', body: `出行备忘的补充说明：${'条目内容彼此独立，'.repeat(25)}相关：[[ghost-page]]` });
  });
  const statePath = path.join(work, '..', 'ns-3b.json');
  const { nightly, messages, audits } = nightlySetup(work, { statePath });
  const r = await nightly.maybeRun();
  assert.equal(r.ran, true);
  const entries = maintenanceEntries(work);
  assert.ok(entries.length >= 4, `dup+薄×2+断链 至少 4 件：${entries.length}`);
  // 公共形状：创建即 held、直达主人、client=nightly、带机器 held 标记
  for (const e of entries) {
    assert.match(e.raw, /^status: held$/m, '创建即 held');
    assert.match(e.raw, /^client: nightly$/m, 'client=nightly');
    assert.match(e.raw, /^keeper_held_at: \d{4}/m, '带 keeper_held_at（held 曲线有效）');
  }
  // dup 对 → merge_pages 预批候选：较长的 dup-b 为 target、dup-a 为 source
  const dupEntry = entries.find((e) => e.raw.includes('dup-a') && e.raw.includes('dup-b'));
  assert.ok(dupEntry, '应有 dup 提案件');
  const dupParsed = parseEntryBody(dupEntry.raw);
  assert.equal(dupParsed.options.length, 2, '两个候选：按提案办/扔掉');
  assert.match(dupParsed.options[0].label, /按提案办/);
  assert.match(dupParsed.options[1].label, /扔掉/);
  assert.equal(dupParsed.options[0].decision.action, 'merge_pages');
  assert.equal(dupParsed.options[0].decision.zone, 'knowledge');
  assert.equal(dupParsed.options[0].decision.target, 'knowledge/dup-b');
  assert.equal(dupParsed.options[0].decision.source, 'knowledge/dup-a');
  assert.equal(dupParsed.options[1].decision.disposition, 'forbidden');
  // 薄页有相近页 → merge_pages 进相近页
  const buddyEntry = entries.find((e) => e.raw.includes('thin-buddy'));
  assert.ok(buddyEntry, '应有薄页合并提案');
  const buddyParsed = parseEntryBody(buddyEntry.raw);
  assert.equal(buddyParsed.options[0].decision.action, 'merge_pages');
  assert.equal(buddyParsed.options[0].decision.target, 'knowledge/params');
  assert.equal(buddyParsed.options[0].decision.source, 'knowledge/thin-buddy');
  // 薄页无相近页 → remove_page（两个候选：删/扔掉提案）
  const aloneEntry = entries.find((e) => e.raw.includes('thin-alone'));
  assert.ok(aloneEntry, '应有薄页删除提案');
  const aloneParsed = parseEntryBody(aloneEntry.raw);
  assert.equal(aloneParsed.options.length, 2);
  assert.equal(aloneParsed.options[0].decision.action, 'remove_page');
  assert.equal(aloneParsed.options[0].decision.target, 'knowledge/thin-alone');
  assert.equal(aloneParsed.options[0].decision.zone, 'knowledge');
  // 断链 → 报告型：只有「扔掉」一个候选、点名断链 stem
  const brokenEntry = entries.find((e) => e.raw.includes('ghost-page'));
  assert.ok(brokenEntry, '应有断链报告件');
  const brokenParsed = parseEntryBody(brokenEntry.raw);
  assert.equal(brokenParsed.options.length, 1, '断链只报告：唯一候选=扔掉');
  assert.match(brokenParsed.options[0].label, /扔掉/);
  assert.equal(brokenParsed.options[0].decision.disposition, 'forbidden');
  // 安全语义：提案件只摘 slug+标题+分数，绝不搬页正文（页内容不进提案面）
  for (const e of entries) {
    assert.ok(!e.raw.includes('闷蒸三十秒'), `提案件不得携带页正文片段：${e.rel}`);
    assert.ok(!e.raw.includes('条目内容彼此独立'), `提案件不得携带页正文片段：${e.rel}`);
  }
  // 通知一句 + audit 计数
  assert.equal(messages.length, 1, '一轮只通知一句');
  assert.match(messages[0], /🌙 夜班提了 \d+ 件维护提案/);
  const runAudit = audits.find((e) => e.event === 'nightly_run');
  assert.ok(runAudit, 'audit 记 nightly_run');
  assert.equal(runAudit.tool, 'nightly');
  assert.ok(runAudit.duplicates >= 1 && runAudit.thin >= 2 && runAudit.broken >= 1, `计数如实：${JSON.stringify(runAudit)}`);
  assert.equal(runAudit.proposed, entries.length, 'proposed=实际落件数');
});

test('3c maybeRun 上限：单轮提案 ≤5，去重类优先、断链靠后被截', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    // 3 组同题 dup 对（组间标题/正文全异，防跨组误配）+ 2 张孤例薄页 + 1 断链 = 6 项检出 > 5
    const pairs = [
      ['园艺剪枝要点',
        '果树剪枝集中在冬末，先去病枝再理交叉枝，切口斜面向外芽，工具用前用后都消毒，大切口涂愈合剂防感染。',
        '玫瑰花后重剪促二次开花，绣球分品种定剪法，冬季休眠期移栽成活率最高，剪下的健康枝条可以扦插繁殖。'],
      ['烘豆记录档案',
        '一爆前的升温速率决定酸质走向，脱水期拉长会钝化明亮度，回温点偏高容易外焦内生，排烟不畅带来烟熏杂味。',
        '浅烘发展时间控制在一爆后一分钟内，中深烘看二爆密集度收豆，杯测要在烘后二十四小时再做才稳定可比。'],
      ['骑行整备清单',
        '长途骑行前检查链条磨损与刹车皮厚度，备胎与补胎片随车带，码表提前下载离线地图，护目镜按天气换镜片。',
        '爬坡齿比要提前规划，补给点间距控制在四十公里内，防晒袖套和电解质片是夏季标配，夜骑必须前后灯全开。'],
    ];
    for (const [i, [title, x, y]] of pairs.entries()) {
      writePage(w, `knowledge/pair-${i}-x.md`, { title, body: x.repeat(5) });
      writePage(w, `knowledge/pair-${i}-y.md`, { title, body: y.repeat(5) });
    }
    writePage(w, 'knowledge/lone-1.md', { title: '戊底稿', body: '戊'.repeat(50) });
    writePage(w, 'knowledge/lone-2.md', { title: '己散记', body: '己'.repeat(50) });
    writePage(w, 'knowledge/linker.md', { title: '链接页样例', body: `出行备忘的补充说明：${'条目内容彼此独立，'.repeat(25)}相关：[[ghost-page]]` });
  });
  const { nightly } = nightlySetup(work, { statePath: path.join(work, '..', 'ns-3c.json') });
  const r = await nightly.maybeRun();
  assert.equal(r.proposed, 5, `单轮上限 5 件：${JSON.stringify(r)}`);
  const entries = maintenanceEntries(work);
  assert.equal(entries.length, 5, '实际落件也是 5');
  assert.ok(!entries.some((e) => e.raw.includes('ghost-page')), '断链类排最后，超限被截');
});

test('3d maybeRun 去重：已有同 target 未决提案不重复提', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/dup-a.md', { title: '萃取笔记副本', body: LONG_A });
    writePage(w, 'knowledge/dup-b.md', { title: '冲煮手记存档', body: LONG_A + '补充：夏天冷萃比例一比十二。' });
    writePage(w, 'knowledge/lone-1.md', { title: '戊底稿', body: '戊'.repeat(50) });
  });
  const statePath = path.join(work, '..', 'ns-3d.json');
  const { nightly } = nightlySetup(work, { statePath });
  const r1 = await nightly.maybeRun();
  assert.equal(r1.proposed, 2, '首轮：dup+薄 两件');
  rmSync(statePath); // 重置节流，模拟下一个到期夜
  const r2 = await nightly.maybeRun();
  assert.equal(r2.ran, true, '第二轮真的跑了');
  assert.equal(r2.proposed, 0, '同 target 未决提案在场 → 一件不重提');
  assert.equal(maintenanceEntries(work).length, 2, 'inbox 里维护件数不变');
});

test('3e maybeRun 容错：inbox 落件抛错 → 吞掉记日志，statePath 仍写（防错误风暴）', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/lone-1.md', { title: '戊残页', body: '戊'.repeat(50) });
  });
  const statePath = path.join(work, '..', 'ns-3e.json');
  const boom = { addEntry: () => { throw new Error('inbox 炸了'); }, listEntries: () => ({ entries: [] }) };
  const nightly = createNightly({
    instanceDir: work, inbox: boom,
    notifier: { notify: async () => ({ ok: true }) },
    audit: () => {}, intervalMs: 604_800_000, statePath,
  });
  const r = await nightly.maybeRun(); // 不得向外抛
  assert.equal(r.ran, true);
  assert.ok(existsSync(statePath), '抛错后 statePath 仍写（下个 tick 不再重跑）');
  const r2 = await nightly.maybeRun();
  assert.equal(r2.ran, false, '状态已推进 → 未到期 no-op');
});

test('3i 保密边界：privacy:sensitive 的 zone（memory）整体不进夜班——提案面不泄敏感页路径/元数据', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    // sensitive 区放「若被扫描必中」的三类诱饵：孤例薄页（→remove 提案）、同题重复对（→merge 提案）、断链（→报告件）。
    // 提案件落 inbox 后经 GET /capture/status 对 capture-trust 全量下发——正文里哪怕只出现
    // memory/ 的 rel 路径/字符数也是把 sensitive 元数据泄给低信任档（其余读路径全是 high-only）。
    writePage(w, 'memory/about-owner/thin-secret.md', { title: '孤例密记', body: '庚'.repeat(40) });
    writePage(w, 'memory/about-owner/habit-x.md', { title: '主人生活习惯', body: `${'早睡早起，工作日午后留深度专注时段，通勤路上听播客，咖啡一天不过两杯，晚餐后散步半小时。'.repeat(5)}相关：[[ghost-secret]]` });
    writePage(w, 'memory/about-owner/habit-y.md', { title: '主人生活习惯', body: '周末倾向户外徒步与摄影，雨天改看非虚构历史书，聚会偏好安静的小馆子，礼物偏实用物件而非摆设。'.repeat(5) });
  });
  const { nightly, audits, messages } = nightlySetup(work, { statePath: path.join(work, '..', 'ns-3i.json') });
  const r = await nightly.maybeRun();
  assert.equal(r.ran, true, '本测只裁范围，夜班本身照跑');
  // inbox 提案面：没有任何提案件正文引用 memory/ 路径或敏感页标题
  const entries = maintenanceEntries(work);
  const leaked = entries.filter((e) => e.raw.includes('memory/'));
  assert.equal(leaked.length, 0, `提案件不得引用 sensitive 区页路径：${leaked.map((e) => e.rel).join(', ')}`);
  assert.ok(!entries.some((e) => e.raw.includes('孤例密记') || e.raw.includes('主人生活习惯')), '提案件不得携带敏感页元数据');
  assert.equal(entries.length, 0, '诱饵全在 sensitive 区 → 本轮零落件');
  assert.equal(messages.length, 0, '零提案不通知');
  // audit nightly_run 计数不含 sensitive 区检出
  const runAudit = audits.find((a) => a.event === 'nightly_run');
  assert.ok(runAudit, 'audit 记 nightly_run（心跳照旧）');
  assert.equal(runAudit.duplicates, 0, 'sensitive 区重复对不进计数');
  assert.equal(runAudit.thin, 0, 'sensitive 区薄页不进计数');
  assert.equal(runAudit.broken, 0, 'sensitive 区断链不进计数');
  assert.equal(runAudit.proposed, 0);
  // scan 口径同样干净（maybeRun 的上游边界）
  const found = nightly.scan();
  const touched = [
    ...found.duplicates.flatMap((d) => [d.a, d.b]),
    ...found.thin.map((t) => t.page),
    ...found.brokenLinks.map((b) => b.page),
  ];
  assert.ok(!touched.some((p) => p.startsWith('memory/')), `scan 不得触及 sensitive 区：${touched.join(', ')}`);
});

// ==================== 组 3b/4：端到端点选执行（keeper 零 LLM）+ tick 接线 ====================

// 会 throw 的 provider：一旦被调用即失败——证明提案件全链路走 SKIP_LLM/预批，绝不进 judge/generateOptions
function throwingProvider() {
  const calls = [];
  return { calls, judge: async (req) => { calls.push(req); throw new Error('SKIP_LLM 违反：provider 被调用了'); } };
}

function e2eSetup(work, { indexStore = null } = {}) {
  const writer = createWriter({ instanceDir: work });
  // F1：inbox 与 keeper 共享同一批准登记表（生产 createApp 同款接线）——resolveEntry 记账、keeper 核验。
  const approvals = new Map();
  const inbox = createInbox({ instanceDir: work, writer, approvals });
  const provider = throwingProvider();
  const messages = [];
  const keeper = createKeeper({
    instanceDir: work, writer, provider, approvals,
    notifier: { notify: async (t) => { messages.push(t); return { ok: true }; } },
    doctor: false, ...(indexStore ? { indexStore } : {}),
  });
  const nightly = createNightly({
    instanceDir: work, inbox,
    notifier: { notify: async () => ({ ok: true }) }, audit: () => {},
    intervalMs: 604_800_000, statePath: path.join(work, '..', 'ns-e2e.json'),
  });
  return { writer, inbox, provider, keeper, nightly, messages };
}

function entryId(raw) {
  return raw.match(/^id: (.+)$/m)[1].trim();
}

test('3f 端到端：夜班 merge_pages 提案 → 点选 option:0 → keeper 零 LLM 执行（并入/删源/清场/索引重建）', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    // 同题 dup 对：正文互异（源页正文并入目标后可用独有片段验真）
    writePage(w, 'knowledge/gear-x.md', { title: '旅行装备清单', body: '出门必带护照与充电器，相机备两块电池，境外通行的实体卡放钱包夹层，雨衣折叠伞看目的地气候决定，转换插头选全球通用型号，登机箱控制在七公斤以内。'.repeat(3) });
    writePage(w, 'knowledge/gear-y.md', { title: '旅行装备清单', body: '徒步路线的装备另算：登山杖一对，速干衣两套，水袋两升，能量胶按每小时一支备货，头灯带备用电池，急救包放最外侧口袋。'.repeat(3) });
  });
  let rebuilds = 0;
  const indexStore = { rebuild: () => { rebuilds++; }, updatePage: () => {} };
  const { inbox, provider, keeper, nightly } = e2eSetup(work, { indexStore });
  await nightly.maybeRun();
  const entries = maintenanceEntries(work);
  assert.equal(entries.length, 1, '一对 dup → 一件提案');
  const resolved = inbox.resolveEntry({ id: entryId(entries[0].raw), option: 0, via: 'cc-main', viaTrust: 'high' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, `点选后应执行落定：${JSON.stringify(result)}`);
  assert.equal(provider.calls.length, 0, '全链路零 LLM（throw-provider 未被触发）');
  // 较长的 gear-x 为保留侧：gear-y 独有正文真的并进来了
  const tgt = readFileSync(path.join(work, 'knowledge/gear-x.md'), 'utf8');
  assert.ok(tgt.includes('登山杖一对'), '源页正文真并入目标页');
  assert.match(tgt, /\*\*\d{4}-\d{2}-\d{2} 夜班合并\*\*（自 knowledge\/gear-y\.md）/, '合并注记带来源');
  assert.ok(!existsSync(path.join(work, 'knowledge/gear-y.md')), '源页删除');
  assert.equal(maintenanceEntries(work).length, 0, '提案件清场');
  assert.ok(rebuilds >= 1, 'merge_pages 删页牵动全库反链 → 索引全量重建');
});

test('3g 端到端：夜班 remove_page 提案（薄页无相近页）→ 点选执行真删页，零 LLM', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/thin-alone.md', { title: '孤丁残稿', body: '丁'.repeat(60) });
  });
  const { inbox, provider, keeper, nightly } = e2eSetup(work);
  await nightly.maybeRun();
  const entries = maintenanceEntries(work);
  assert.equal(entries.length, 1, '一张孤例薄页 → 一件删除提案');
  const resolved = inbox.resolveEntry({ id: entryId(entries[0].raw), option: 0, via: 'cc-main', viaTrust: 'high' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, `点选后应执行：${JSON.stringify(result)}`);
  assert.equal(provider.calls.length, 0, '零 LLM');
  assert.ok(!existsSync(path.join(work, 'knowledge/thin-alone.md')), '薄页真删（git 历史可找回）');
  assert.equal(maintenanceEntries(work).length, 0, '提案件清场');
});

test('3h 端到端：点选「扔掉这提案」→ 件清场、页原封不动、零 LLM', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/thin-alone.md', { title: '孤丁残稿', body: '丁'.repeat(60) });
  });
  const { inbox, provider, keeper, nightly } = e2eSetup(work);
  await nightly.maybeRun();
  const entries = maintenanceEntries(work);
  const resolved = inbox.resolveEntry({ id: entryId(entries[0].raw), option: 1, via: 'cc-main', viaTrust: 'high' });
  await resolved.synced;
  const result = await keeper.processPending();
  assert.equal(result.rejected, 1, '扔掉走 forbidden → rejected');
  assert.equal(provider.calls.length, 0, '零 LLM');
  assert.ok(existsSync(path.join(work, 'knowledge/thin-alone.md')), '页原封不动');
  assert.equal(maintenanceEntries(work).length, 0, '主人裁定的扔掉 → 件清场');
});

// 全 MCP 工具面回归（与 schema-evolution E1 同一验收缺口的夜班侧）：主频道 agent 对夜班 maintenance
// 提案件的批准同样走 MCP inbox_resolve({option})——此前 inputSchema 剥掉 option → re-held 永远批不动。
const servers = [];
after(() => { for (const s of servers) s.close(); });

test('3j 全 MCP 面：夜班提案 → MCP inbox_resolve({id,ruling,option:0}) → keeper 零 LLM 真删页', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/thin-alone.md', { title: '孤丁残稿', body: '丁'.repeat(60) });
  });
  // app 先起，keeper/nightly 全挂 app.locals.writer（生产 index 入口同款接线）：MCP 写与归档提交同队列
  const app = createApp({ instanceDir: work, tokens: { 'w-primary': { client: 'cc-main', trust: 'high', channel: 'primary' } } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const provider = throwingProvider();
  const keeper = createKeeper({
    instanceDir: work, writer: app.locals.writer, provider, approvals: app.locals.approvals, // F1：与 app 内 inbox 共享登记表
    notifier: { notify: async () => ({ ok: true }) }, doctor: false,
  });
  const nightly = createNightly({
    instanceDir: work, inbox: createInbox({ instanceDir: work, writer: app.locals.writer, approvals: app.locals.approvals }),
    notifier: { notify: async () => ({ ok: true }) }, audit: () => {},
    intervalMs: 604_800_000, statePath: path.join(work, '..', 'ns-mcp.json'),
  });
  await nightly.maybeRun();
  const entries = maintenanceEntries(work);
  assert.equal(entries.length, 1, '一张孤例薄页 → 一件删除提案');
  // 主频道 agent 的真实动作：MCP 工具面点选批准（修前 option 被 zod 剥掉 → 纯文字裁定 → re-held）
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer w-primary' } },
  }));
  const r = await client.callTool({ name: 'inbox_resolve', arguments: { id: entryId(entries[0].raw), ruling: '批', option: 0 } });
  assert.notEqual(r.isError, true, `inbox_resolve 不应报错：${r.content?.[0]?.text}`);
  await client.close();
  const result = await keeper.processPending();
  assert.equal(result.filed, 1, `MCP 点选批准应执行（修前：re-held proposal-needs-option）：${JSON.stringify(result)}`);
  assert.equal(provider.calls.length, 0, '全链路零 LLM');
  assert.ok(!existsSync(path.join(work, 'knowledge/thin-alone.md')), '薄页真删（git 历史可找回）');
  assert.equal(maintenanceEntries(work).length, 0, '提案件清场');
});

test('4a keeper tick 每轮勾一次 nightly.maybeRun（F4：已移出归档锁 running）', async () => {
  const { work } = makeGitInstance();
  const writer = createWriter({ instanceDir: work });
  let calls = 0;
  const keeper = createKeeper({
    instanceDir: work, writer, provider: throwingProvider(),
    notifier: { notify: async () => ({ ok: true }) },
    doctor: false,
    nightly: { maybeRun: async () => { calls++; return { ran: false }; } },
  });
  const r1 = await keeper.processPending();
  assert.equal(r1.skipped, undefined, '正常轮次');
  assert.equal(calls, 1, '每轮 tick 勾一次');
  await keeper.processPending();
  assert.equal(calls, 2, '下一轮再勾一次');
});

test('4b(F4) 夜班移出归档锁：nightly 在途时 processPending 仍受理新 pending（不被 running 门挡）', async () => {
  const { work } = makeGitInstance();
  const writer = createWriter({ instanceDir: work });
  const inbox = createInbox({ instanceDir: work, writer });
  const filingProvider = { judge: async () => ({ json: { disposition: 'canonical', zone: 'todo', action: 'todo_add', target: 'owner', summary: 's', confidence: 0.99 }, model: 'flash', usage: {} }) };
  // 受控 barrier 的 nightly：maybeRun 卡在 barrier 直到 release——模拟长扫描/慢 push 在途。
  let entered = false, release;
  const barrier = new Promise((r) => { release = r; });
  const nightly = { maybeRun: async () => { entered = true; await barrier; return { ran: true }; } };
  const keeper = createKeeper({
    instanceDir: work, writer, provider: filingProvider,
    notifier: { notify: async () => ({ ok: true }) }, doctor: false, nightly,
  });
  // tick1：空 pending → processPending 同步跑到 maybeRun 并卡在 barrier。F4 下此时归档锁 running 应已释放。
  const tick1 = keeper.processPending();
  assert.equal(entered, true, 'nightly.maybeRun 已进入（processPending 同步跑到这里）');
  // 夜班在途时投入新 pending
  const r = inbox.addEntry({ kind: 'todo', content: '夜班在途时进来的待办', client: 'cc-test' });
  await r.synced;
  // tick2：旧行为下 running 仍被夜班占用 → 返回 {skipped:true}；F4 下 running 已释放 → 正常受理归档
  const tick2 = await keeper.processPending();
  assert.notEqual(tick2.skipped, true, 'nightly 在途 → 下一轮 processPending 不该被归档锁 running 挡（结构性）');
  assert.equal(tick2.filed, 1, '新 pending 在夜班在途时仍被受理归档（不阻塞）');
  assert.match(readFileSync(path.join(work, 'todo', 'owner.md'), 'utf8'), /夜班在途时进来的待办/);
  release();
  await tick1; // 收尾 barrier，避免悬挂 promise
});

test('4c(G4) 夜班提案写入进 writer.transact（写与 commit 同队列，不走队列外 commitAndPush）', async () => {
  const { work } = makeGitInstance();
  seedCommit(work, (w) => {
    padFixture(w);
    writePage(w, 'knowledge/thin-alone.md', { title: '孤丁残稿', body: '丁'.repeat(60) });
  });
  const real = createWriter({ instanceDir: work });
  const events = [];
  let wroteBeforeCommit = false;
  const writer = {
    commitAndPush: (opts) => { events.push('commitAndPush'); return real.commitAndPush(opts); },
    transact: (fn) => {
      events.push('transact');
      // 包一层 commit：断言「提案文件在 transact 内、commit 之前即落盘」（写与 commit 边界一致）
      return real.transact((commit) => fn(async (o) => {
        wroteBeforeCommit = o.paths.every((p) => existsSync(path.join(work, p)));
        return commit(o);
      }));
    },
  };
  const inbox = createInbox({ instanceDir: work, writer });
  const nightly = createNightly({
    instanceDir: work, inbox,
    notifier: { notify: async () => ({ ok: true }) }, audit: () => {},
    intervalMs: 604_800_000, statePath: path.join(work, '..', 'ns-4c.json'),
  });
  const r = await nightly.maybeRun();
  assert.equal(r.proposed, 1, '一张孤例薄页 → 一件提案');
  assert.ok(events.includes('transact'), '夜班提案经 writer.transact 写入（写与 commit 同队列）');
  assert.ok(!events.includes('commitAndPush'), '夜班提案不再走队列外 commitAndPush（并发 keeper [.] 提交不再卷入半写文件）');
  assert.ok(wroteBeforeCommit, '提案文件在 transact 内、commit 前即落盘');
  assert.equal(maintenanceEntries(work).length, 1, '提案件落盘');
});
