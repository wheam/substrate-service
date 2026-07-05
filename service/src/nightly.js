// 夜班 v0（M4.4 D3）：纯确定性零 LLM 的维护扫描——挂在 keeper tick 里跑，产出「预批提案」走 inbox
// 点选通路（创建即 held 直达主人；merge_pages/remove_page 执行前有 rulingMarked 硬校验，数据永不触发删页）。
// 明确不做（v0 裁剪，理由入 docs §9）：孤儿检测、矛盾旗标、keeper 聚簇自动提 zone。
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseZones } from './acl.js';

// 骨架/流水区不进扫描：inbox 件与判例是流水、governance/skills 是骨架——它们不是「维护对象」，
// 且 inbox 正文是对抗输入，绝不该被相似度算法搬运进提案面。
const SKELETON_DIRS = new Set(['inbox', 'keeper-feedback', 'governance', 'skills']);
const DUP_THRESHOLD = 0.6;      // 近似去重：标题词集 Jaccard 与正文前 500 字符 bigram Jaccard 取大者
const THIN_CHARS = 200;         // 薄页：去 frontmatter 的正文严格小于此值
const CANDIDATE_THRESHOLD = 0.3; // 薄页合并候选的最低相似度（低于去重阈值：沾边即可给主人一个「并入」选项）
const MAX_PROPOSALS = 5;        // 每轮提案上限：夜班是低频建议者，不许一晚刷屏

// 标题分词：CJK 逐字 + 拉丁/数字连串——中文标题按词集 Jaccard 时整串比对几乎全有或全无，逐字才有区分度
function titleTokens(title) {
  return new Set(String(title).toLowerCase().match(/[\p{Script=Han}]|[a-z0-9]+/gu) ?? []);
}

// 正文前 500 字符的字符 bigram 集（空白折叠成单空格，排版差异不算内容差异）
function bodyBigrams(body) {
  const s = String(body).slice(0, 500).replace(/\s+/g, ' ');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function similarity(p, q) {
  return Math.max(jaccard(p.titleSet, q.titleSet), jaccard(p.bigramSet, q.bigramSet));
}

export function createNightly({
  instanceDir, inbox, notifier, audit = () => {},
  intervalMs = 604_800_000, // 默认 7 天；0=禁用
  // 状态文件在实例 git 之外（与 recall-index 同级惯例）：lastRun 是运维状态，不是知识，不进库
  statePath = path.resolve(instanceDir, '..', 'nightly-state.json'),
} = {}) {
  // 扫描对象：zones.md 注册、路径不落骨架区、且非 privacy:sensitive 的 zone 下全部 .md（递归），
  // 排除 README 与 _ 前缀结构/流水页。sensitive 区（如 memory）整体不进夜班：提案件正文会带页的
  // rel 路径/字符数等元数据，而它落 inbox 后除 inbox_list/nudge 外还经 GET /capture/status 对
  // capture-trust token 全量下发（server.js 的 mineOnly 只挡低信任档）——系统其余读路径全把
  // sensitive 锁 high-only（acl.js canReadZone、/mcp 403、digest high-only），提案面若含 memory/
  // 路径即越界泄漏。宁可敏感区的薄页/重复页由主人自己打理，夜班一页不碰。
  function listPages() {
    const zones = parseZones(instanceDir).filter((z) => z.path && !SKELETON_DIRS.has(z.path.split('/')[0]) && z.privacy !== 'sensitive');
    const pages = [];
    for (const z of zones) {
      const root = path.join(instanceDir, z.path);
      if (!existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        for (const name of readdirSync(d)) {
          const p = path.join(d, name);
          if (statSync(p).isDirectory()) { stack.push(p); continue; }
          if (!name.endsWith('.md') || name === 'README.md' || name.startsWith('_')) continue;
          const raw = readFileSync(p, 'utf8');
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
          const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() || name.replace(/\.md$/, '');
          const rel = path.relative(instanceDir, p).split(path.sep).join('/');
          pages.push({ rel, zone: z.id, title, body, titleSet: titleTokens(title), bigramSet: bodyBigrams(body) });
        }
      }
    }
    pages.sort((a, b) => a.rel.localeCompare(b.rel)); // 确定性输出顺序
    return pages;
  }

  // 全库 .md stem 集（断链判定面）：链接目标可能在任何目录，故不按 zone 裁剪，只排除 .git
  function allStems() {
    const stems = new Set();
    const stack = [instanceDir];
    while (stack.length) {
      const d = stack.pop();
      for (const name of readdirSync(d)) {
        if (name === '.git') continue;
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) stack.push(p);
        else if (name.endsWith('.md')) stems.add(name.replace(/\.md$/, ''));
      }
    }
    return stems;
  }

  // 纯函数可测：三类确定性检出，不写任何文件
  function scan() {
    const pages = listPages();
    const duplicates = [];
    const thin = [];
    const brokenLinks = [];

    // 近似去重（同 zone 内两两比对）：a=保留侧（正文较长者，等长取 rel 字典序小者），b=并入侧
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const p = pages[i], q = pages[j];
        if (p.zone !== q.zone) continue;
        const score = similarity(p, q);
        if (score < DUP_THRESHOLD) continue;
        const [keep, merge] = q.body.length > p.body.length ? [q, p] : [p, q];
        duplicates.push({ a: keep.rel, b: merge.rel, zone: p.zone, score: Math.round(score * 100) / 100 });
      }
    }

    // 薄页：正文 <200 字符；合并候选=同 zone 最相似页（≥0.3 才算沾边），没有就 null（→ remove 提案）
    for (const p of pages) {
      if (p.body.length >= THIN_CHARS) continue;
      let best = null, bestScore = 0;
      for (const q of pages) {
        if (q === p || q.zone !== p.zone) continue;
        const score = similarity(p, q);
        if (score > bestScore) { best = q; bestScore = score; }
      }
      thin.push({ page: p.rel, chars: p.body.length, mergeCandidate: bestScore >= CANDIDATE_THRESHOLD ? best.rel : null });
    }

    // 断链：[[stem]]（管道/锚点后缀剥掉、带路径取末段）在全库无 <stem>.md。v0 只报告不修
    // （executor 无文本编辑动作，自动改正文的风险大于收益）。
    const stems = allStems();
    for (const p of pages) {
      const seen = new Set();
      for (const m of p.body.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        const stem = m[1].split(/[|#]/)[0].trim().split('/').pop();
        if (!stem || stems.has(stem) || seen.has(stem)) continue;
        seen.add(stem);
        brokenLinks.push({ page: p.rel, stem });
      }
    }

    return { duplicates, thin, brokenLinks };
  }

  // 把三类检出翻译成「预批提案」（人话 + 摘要 json 块 + 点选候选块）。安全语义：提案件本身进响应面
  // （inbox_list 全文可见、GET /capture/status 对 capture-trust 全量下发、nudge/digest 以 id/kind 提示），
  // 正文只摘 rel 路径+分数/字符数（不含标题）、绝不搬页正文；且 listPages 已整体排除 sensitive 区——
  // 「不造新泄漏面」以这两条同时成立为前提（rel 路径本身对非 high 档就是敏感元数据）。
  function buildProposals({ duplicates, thin, brokenLinks }) {
    const discard = { label: '扔掉这提案', decision: { disposition: 'forbidden', reject_reason: '主人扔掉了这条夜班维护提案' } };
    const proposals = [];
    // F2：json 块是提案件的【权威可见 payload】——keeper 点选执行时从这里重建/校验决定（op + zone + source/target
    // 与隐藏 options 的 decision 必须一致，否则 re-held）。op 命名 executor 动作，source/target 用带 .md 的 rel。
    const mergeProposal = (kind, zone, source, target, extra, line) => ({
      involved: [source, target],
      content: `${line}\n\n\`\`\`json\n${JSON.stringify({ op: 'merge_pages', type: kind, zone, source, target, ...extra }, null, 2)}\n\`\`\`\n`,
      optionsBlock: {
        options: [
          {
            label: '✅ 按提案办',
            decision: {
              disposition: 'canonical', action: 'merge_pages', zone,
              // decision 用去 .md 的 slug（executor 的页寻址惯例）；正文/json 块用带 .md 的 rel（去重匹配面）
              source: source.replace(/\.md$/, ''), target: target.replace(/\.md$/, ''),
              summary: `夜班维护：${source} 并入 ${target}`, confidence: 1,
            },
          },
          discard,
        ],
      },
    });
    for (const d of duplicates) {
      proposals.push(mergeProposal('duplicate', d.zone, d.b, d.a, { score: d.score },
        `夜班发现疑似重复页：${d.b} 与 ${d.a} 相似度 ${d.score}。建议把前者并入后者（源页正文并入、删源页、清全库反链）。`));
    }
    for (const t of thin) {
      const zone = zoneOf(t.page);
      if (t.mergeCandidate) {
        proposals.push(mergeProposal('thin-merge', zone, t.page, t.mergeCandidate, { chars: t.chars },
          `夜班发现薄页：${t.page} 正文仅 ${t.chars} 字符，且与 ${t.mergeCandidate} 相近。建议并入后者（源页正文并入、删源页、清全库反链）。`));
      } else {
        proposals.push({
          involved: [t.page],
          content: `夜班发现薄页：${t.page} 正文仅 ${t.chars} 字符，且全库无相近页。建议删除（git 历史可找回）。\n\n\`\`\`json\n${JSON.stringify({ op: 'remove_page', type: 'thin-remove', zone, page: t.page, chars: t.chars }, null, 2)}\n\`\`\`\n`,
          optionsBlock: {
            options: [
              {
                label: '✅ 按提案办',
                decision: {
                  disposition: 'canonical', action: 'remove_page', zone, target: t.page.replace(/\.md$/, ''),
                  summary: `夜班维护：删除薄页 ${t.page}`, confidence: 1,
                },
              },
              discard,
            ],
          },
        });
      }
    }
    for (const b of brokenLinks) {
      // v0 报告型：executor 无文本编辑动作，不自动改正文——只给主人一份可扔的报告
      proposals.push({
        involved: [b.page],
        content: `夜班发现断链：${b.page} 里引用的 [[${b.stem}]] 在全库没有对应页。v0 不自动改正文，请主人抽空处理；此件看过即可扔掉。\n\n\`\`\`json\n${JSON.stringify({ type: 'broken-link', page: b.page, stem: b.stem }, null, 2)}\n\`\`\`\n`,
        optionsBlock: { options: [discard] },
      });
    }
    return proposals;
  }

  function zoneOf(rel) {
    const z = parseZones(instanceDir).find((x) => x.path && rel.startsWith(x.path));
    return z?.id ?? rel.split('/')[0];
  }

  function readState() {
    try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; }
  }

  // 到期才跑：扫描 → 去重后逐件落 held 提案（≤5）→ 通知+审计。任何一步抛错都吞掉记日志，
  // 且 statePath 无论成败都推进——否则一处持续报错会让每个 keeper tick 重扫全库（错误风暴）。
  async function maybeRun() {
    if (!(Number(intervalMs) > 0)) return { ran: false, reason: 'disabled' };
    const last = readState().lastRun;
    // lastRun 非法（损坏的状态文件）→ Date.parse 得 NaN → 比较不成立 → 视为到期重跑（自愈）
    if (last && Date.now() - Date.parse(last) < Number(intervalMs)) return { ran: false, reason: 'not-due' };
    const t0 = Date.now();
    const out = { ran: true, duplicates: 0, thin: 0, broken: 0, proposed: 0 };
    try {
      const found = scan();
      out.duplicates = found.duplicates.length;
      out.thin = found.thin.length;
      out.broken = found.brokenLinks.length;
      // 未决（pending/held）的维护提案正文里已出现同一页 → 不重复提。正文 2000 字符截断远大于提案件体量，
      // json 块里的 rel 一定在匹配面内。
      const pendingBodies = inbox.listEntries().entries
        .filter((e) => e.kind === 'maintenance' && (e.status === 'held' || e.status === 'pending'))
        .map((e) => e.content);
      const claimed = new Set(); // 本轮内一页只进一件提案，防「A 并入 B」与「删 B」同夜互撞
      for (const p of buildProposals(found)) {
        if (out.proposed >= MAX_PROPOSALS) break;
        if (p.involved.some((rel) => claimed.has(rel) || pendingBodies.some((c) => c.includes(rel)))) continue;
        // G4：queuedWrite——写入进 writer.transact，与 commit 同队列串行点成对发生（写与 commit 边界一致），
        // 并发 keeper 的 paths:['.'] 提交不会把半写的夜班提案文件卷进无关 commit。
        const receipt = inbox.addEntry({ kind: 'maintenance', client: 'nightly', status: 'held', content: p.content, optionsBlock: p.optionsBlock, queuedWrite: true });
        await receipt.synced;
        for (const rel of p.involved) claimed.add(rel);
        out.proposed++;
      }
      // 零提案不打扰主人——audit 的 nightly_run 已是心跳，通知只在真有事时发
      if (out.proposed > 0) {
        await notifier.notify(`🌙 夜班提了 ${out.proposed} 件维护提案，主频道或 App 里点选处理即可（不点不动手）。`);
      }
      audit({ tool: 'nightly', event: 'nightly_run', duplicates: out.duplicates, thin: out.thin, broken: out.broken, proposed: out.proposed, ms: Date.now() - t0 });
    } catch (e) {
      out.error = e.message;
      console.error(`夜班本轮失败（状态仍推进，下轮到期再试）：${e.message}`);
    } finally {
      try { writeFileSync(statePath, JSON.stringify({ lastRun: new Date().toISOString() })); }
      catch (e) { console.error(`夜班状态文件写入失败：${e.message}`); }
    }
    return out;
  }

  return { scan, maybeRun };
}
