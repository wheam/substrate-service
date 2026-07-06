// inbox 隔离区：一切写入先落这里（写路径无 LLM，秒回受理回执），keeper 审核后才进正式区。
// 凭据红线在落盘之前扫——命中即拒收，密钥永不进 git。
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 导出供读路径复验：实例仓库经 git pull 同步，inbox 件可以不经 addEntry、被手工伪造后拉进来——
// 「kind 合法、id 是服务端生成的」只在写路径成立，任何要把 id/kind 拼进响应面的读方必须自己再验。
// schema/maintenance = M4.4 提案件（D2）：创建即 held、直达主人，keeper 不 LLM 判它们（走点选预批通路）。
export const KINDS = new Set(['save', 'todo', 'collection', 'memory', 'remove', 'todo_done', 'capture', 'schema', 'maintenance']);

// F4（M4.6 Finding4）kind 规范化：inbox 件经 git pull 拉进来时 frontmatter 的 `kind:` 是任意文本——
// 大小写/首尾空白变体（`Maintenance`、` maintenance `、`SCHEMA`）会让【展示面】（server.js 的 D2 过滤按
// CAPTURE_UNRULABLE_KINDS.has(e.kind) 决定 App 是否列出）与【执行面】（keeper 的 SKIP_LLM/maintenance 守卫按
// entry.kind 判定）对同一件得出不同结论 → 无权兑现的按钮泄进 App / 治理件被当普通件跑 LLM。统一在解析点
// trim+lowercase 归一（listEntries 与 keeper.parseEntry 都过它），令两面看到的 kind 完全一致。approvalToken 也
// 绑 kind——两处解析都归一后哈希口径仍一致（合法件本就是小写、归一是恒等；swap 到任意大小写变体仍失配 → re-held）。
export function normKind(k) {
  return String(k ?? '').trim().toLowerCase();
}
// 服务端生成 id 的形状（见 addEntry：Date.now 的 base36 + '-' + 2 字节 hex）。
// 首段长度上限放到 12：只为防伪造件灌长文本，不过拟合当前时间戳位数（base36 毫秒到 2059 年也才 9 位）。
export const ID_FORMAT = /^[a-z0-9]{1,12}-[a-f0-9]{4}$/;

// 与引擎 doctor 的凭据扫描同族的模式集（服务侧写路径前置一道）
const CREDENTIAL_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,            // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/,               // OpenAI / DeepSeek 风格
  /AKIA[0-9A-Z]{16}/,                    // AWS access key
  /ghp_[A-Za-z0-9]{20,}/,                // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/,        // GitHub fine-grained PAT
  /gho_[A-Za-z0-9]{20,}/,                // GitHub OAuth
  /xox[baprs]-[A-Za-z0-9-]{10,}/,        // Slack
  /AIza[0-9A-Za-z_-]{30,}/,              // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM 私钥
];

// F1（Critical）进程内批准登记表：resolveEntry 是【唯一】合法批准入口（MCP inbox_resolve / App
// /capture/resolve 都经它、都在本进程）。它敲定 ruling+approvedDecision 后向 approvals Map 记一笔
// id→{token, viaTrust}；keeper 只在登记表命中且 token 匹配时才认「主人批准」，绝不信文件里裸的
// owner_ruling / owner-decision 块（git pull 可伪造任何 frontmatter/正文）。createApp 建这一个 Map、
// 经 app.locals.approvals 同时给 inbox 与 keeper。缺省 new Map()：单独构造的 inbox（无共享 Map）
// 记的账无人核验 = 安全失败（相关件重判/re-held），不会误放行。
// token 覆盖 id+ruling+decision + rel + 被批文件正文（G1）；viaTrust（capture/high…）另存 Map value——
// 通道限权（capture 无权删页）是认证相关决定，同样只认 registry，不认文件里的 ruling_via_trust（伪造件可随意改写它）。
// G1（Critical）approve-then-swap：旧 token 只绑 id+ruling+decision，keeper/executor 之后又【重读可变文件】
// 拿 payload（schema applySchema）/body（new_page/merge_into）——批准落定后经 git pull 换掉正文/payload
// （owner_ruling/owner-decision 块不动 → 旧 token 仍验过）即被按篡改内容执行。故把「被批对象」也绑进哈希：
// rel 定位文件、content=parseEntryBody(当前raw).content（已剥掉易变的 keeper 注记/options/owner-decision 块、
// 却含 schema 的 ```json payload 块，稳定可复算）。resolveEntry 按最终落盘文件记账；keeper honor 前对当前
// 文件复算同款——不匹配即不认证 → approved_decision 作废 → re-held（fail-safe）。
// H1（Critical）：kind 在 frontmatter、被 parseEntryBody 剥掉、原不进 token，却是可执行字段——keeper 的
// maintenance 守卫只在 kind==='maintenance' 触发、remove_page 放行独立于 kind。批准一个 maintenance 提案后
// 仅把 kind: maintenance→save（token 不含 kind 仍验过）即绕过维护守卫删要害页。故 kind 也绑进哈希（rel 与
// content 之间）——kind 是 resolveEntry 从不改写的稳定字段，绑它安全；swap kind → 哈希失配 → 不认证 → re-held。
export function approvalToken({ id, ruling, decision, rel = '', kind = '', content = '' }) {
  const norm = `${id}\n${oneline(ruling)}\n${decision ? JSON.stringify(decision) : ''}\n${rel}\n${kind}\n${content}`;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

export function createInbox({ instanceDir, writer, indexStore = null, approvals = new Map() }) {
  // status/optionsBlock（M4.4 D2）：提案件创建即 status:'held'（直达主人，不经 keeper LLM）并带确定性候选块，
  // 走与 keeper held 同一条点选预批通路（resolveEntry({option}) → owner-decision → keeper 直执行）。缺省保持旧行为。
  // queuedWrite（G4）：把「写入」也放进 writer.transact，与 commit 在同一队列串行点成对发生。夜班（nightly）
  // 提案走这条——否则 writeFileSync 在队列外先落盘，并发 keeper 的 paths:['.'] 提交可能把半写的提案文件卷进
  // 无关 commit（git 历史不整洁）。缺省 false：save/capture/resolve 等其余写路径行为不变。
  function addEntry({ kind, content = '', hint, client, payload, status = 'pending', optionsBlock = null, queuedWrite = false }) {
    if (!KINDS.has(kind)) throw new Error(`未知的 kind：${kind}`);
    const scanTarget = `${content}\n${payload ? JSON.stringify(payload) : ''}\n${hint ?? ''}`;
    // 凭据模式要求连续字符——把 key 用空格/换行/零宽字符切碎（`sk-ab cd ef…` / `sk-abcdefghij\n0123…` /
    // 零宽空格夹在段间）即可逐段逃过 \bsk-[A-Za-z0-9]{20,} 之类。故【同时】扫原文与「折叠掉全部空白【及零宽/
    // 格式字符】的副本」：任一命中即拒。只对折叠副本额外把关，不改任何模式；\b 前缀（如 \bsk-）在折叠后仍需
    // 词边界，普通散文里 task/risk/disk 等含 sk 子串的词不在词边界起「sk-」，不会被误伤（见 inbox.test.js 的
    // FP 护栏）。原文扫描保留：含内建空格的模式（PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----`）折叠后反而不匹配，
    // 靠原文这一遍兜住。隐形/组合字符同样能拆碎 key，且 \s 全漏：\p{Cf}=格式字符（零宽空格 U+200B /
    // word-joiner U+2060 / BOM U+FEFF）、\p{Mn}/\p{Me}=组合标记（variation selector U+FE0F / combining
    // grapheme joiner U+034F / 各类重音声调）、\p{Cc}=控制字符。故折叠副本扩为剥 [\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]
    //（需 u 标志）。这几类几近穷尽「视觉/功能可忽略、能隐形拆 key」的字符空间——可见字符（如 `sk-a.b.c`）拆
    // key 会破坏其可用性、非有效攻击，不剥；\p{Mc}（可见的间距组合标记）FP 高且可见，不纳入。正常内容极罕见含
    // 这些字符，剥后仅当巧合凑成词边界凭据前缀才误判（FP 面比纯空白略大但可控，见 inbox.test.js 组合标记 FP 护栏）。
    const collapsedTarget = scanTarget.replace(/[\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]+/gu, '');
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(scanTarget) || pattern.test(collapsedTarget)) {
        throw new Error('拒收：内容含疑似密钥/凭据（红线：密钥原文绝不进库）。请脱敏后重试。');
      }
    }

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const receivedAt = new Date().toISOString();
    // `_` 前缀 = doctor 的结构页豁免（流水条目不做孤儿/互链/索引检查）
    const filename = `_${receivedAt.slice(0, 10)}-${id}.md`;
    const relPath = `inbox/${filename}`;

    const fm = [
      '---',
      `title: 收件 ${id}`,
      `created: ${receivedAt.slice(0, 10)}`,
      `updated: ${receivedAt.slice(0, 10)}`,
      'type: inbox',
      `id: ${id}`,
      `received_at: ${receivedAt}`,
      `client: ${oneline(client)}`,
      `kind: ${kind}`,
      ...(hint ? [`hint: ${oneline(hint)}`] : []),
      ...(payload?.name ? [`collection: ${oneline(payload.name)}`] : []),
      // status:'held' 的提案件同时落 keeper_held_at 机器标记：resolveEntry 只信 frontmatter 这个键算 held→裁定
      // 耗时（held_ms 曲线），令提案件的这条曲线同样有效（正文伪造无法进 frontmatter）。
      ...(status === 'held' ? [`keeper_held_at: ${receivedAt}`] : []),
      `status: ${status}`,
      '---',
      '',
    ].join('\n');
    let body = payload?.row
      ? '```json\n' + JSON.stringify(payload.row, null, 2) + '\n```\n'
      : content.trim() + '\n';
    // 预批候选块：与 keeper held 写的 <!--keeper-options--> 同形状，parseEntryBody 照常读回、resolveEntry({option}) 照常点选。
    if (optionsBlock) body += `\n<!--keeper-options\n${JSON.stringify(optionsBlock)}\n-->\n`;

    const abs = path.join(instanceDir, relPath);
    const fileText = fm + body;
    const message = `inbox: 收件 ${id} (${kind} via ${client})`;
    mkdirSync(path.join(instanceDir, 'inbox'), { recursive: true });

    const receipt = { id, path: relPath, status };
    if (queuedWrite) {
      // G4：write 与 commit 同进 transact——写与提交边界一致，并发的整树提交不会卷进半写文件。
      receipt.synced = writer.transact(async (commit) => {
        writeFileSync(abs, fileText);
        return commit({ paths: [relPath], message });
      });
    } else {
      // 落盘即受理；git 同步在后台单写者队列里完成，不阻塞回执
      writeFileSync(abs, fileText);
      receipt.synced = writer.commitAndPush({ paths: [relPath], message });
    }
    return receipt;
  }

  function listEntries() {
    const dir = path.join(instanceDir, 'inbox');
    if (!existsSync(dir)) return { entries: [] };
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith('_') && f.endsWith('.md'))
      .map((f) => {
        const raw = readFileSync(path.join(dir, f), 'utf8');
        const get = (k) => raw.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1] ?? '';
        const parsed = parseEntryBody(raw);
        return {
          id: get('id'), path: `inbox/${f}`, kind: normKind(get('kind')), status: get('status'),
          received_at: get('received_at'), hint: get('hint') || undefined,
          client: get('client'), excerpt: parsed.content.slice(0, 120), content: parsed.content.slice(0, 2000),
          reason: parsed.reason, options: parsed.options.map((o, i) => ({ index: i, label: o.label })),
        };
      });
    return { entries };
  }

  // 主人裁定：把件复位为 pending 并携带 owner_ruling，keeper 下一轮按裁定执行并自动立判例。
  // via/viaTrust 记录裁定进来的通道——capture 通道的裁定在执行层被限权（如无权删页）。
  function resolveEntry({ id, ruling, option, via, viaTrust }) {
    const { entries } = listEntries();
    const hit = entries.find((e) => e.id === id);
    if (!hit) {
      throw new Error(`找不到收件 ${id}。当前 inbox 里有：${entries.map((e) => `${e.id}(${e.status})`).join('、') || '（空）'}`);
    }
    const abs = path.join(instanceDir, hit.path);
    let approvedDecision = null;
    if (option !== undefined && option !== null) {
      // 点选候选方案：取出该方案的完整决定作为预批，keeper 直接执行不再重判
      const parsed = parseEntryBody(readFileSync(abs, 'utf8'));
      const chosen = parsed.options[Number(option)];
      if (!chosen) throw new Error(`没有候选方案 #${option}（共 ${parsed.options.length} 个）`);
      ruling = chosen.label;
      approvedDecision = chosen.decision;
    }
    if (!ruling?.trim()) throw new Error('ruling 不能为空');
    let raw = readFileSync(abs, 'utf8');
    // held→被裁定耗时（供使用仪表的 held 半衰期曲线）：只信 keeper 写进【frontmatter】的机器可辨标记
    // keeper_held_at——它在文件首个 ---…--- 块内，正文数据无法伪造进去（旧版全文扫 **keeper held**
    // 文本注记会被捕获正文里巧合/恶意的同款字样污染）。keeper 每次 held 覆盖该字段 → 天然取最后一次。
    // 件此前没被 held 过（如直接对 pending 件裁定），或只有旧文本注记的历史件：无该字段 → held_at/ms=null（不崩）。
    const fmBlock = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const heldAt = fmBlock.match(/^keeper_held_at: (.+)$/m)?.[1]?.trim() || null;
    const resolvedAt = new Date().toISOString();
    const heldStart = heldAt ? Date.parse(heldAt) : NaN;
    let heldMs = Number.isFinite(heldStart) ? Date.parse(resolvedAt) - heldStart : null;
    if (heldMs != null && heldMs < 0) heldMs = null; // 负数（时钟错乱/未来时间戳）不可信 → 置 null
    raw = raw
      .replace(/^status: .*$/m, 'status: pending')
      .replace(/^updated: .*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`)
      // 缺陷2b：复位已拒件时清掉 keeper 打的 tier: rejected 旗标——否则件虽复位 pending，frontmatter 仍带
      // rejected 残留，索引旧行继续可查。清行 + 下方 refreshIndex 一并抹掉派生索引里的隔离-rejected 残留。
      .replace(/^tier: .*\n/m, '')
      .replace(/^owner_ruling: .*\n/m, '')
      .replace(/^ruling_via: .*\n/m, '')
      .replace(/^ruling_via_trust: .*\n/m, '');
    const rulingLines = [
      `owner_ruling: ${oneline(ruling)}`,
      ...(via ? [`ruling_via: ${oneline(via)}`, `ruling_via_trust: ${oneline(viaTrust ?? '')}`] : []),
    ].join('\n');
    raw = raw.replace(/^status: pending$/m, `${rulingLines}\nstatus: pending`);
    raw = raw.replace(/<!--owner-decision\n[\s\S]*?\n-->\n?/g, '');
    if (approvedDecision) {
      raw += `\n<!--owner-decision\n${JSON.stringify(approvedDecision)}\n-->\n`;
    }
    writeFileSync(abs, raw);
    // F1/G1：记账进批准登记表。token 覆盖 id+ruling+decision + rel + 被批文件正文（按最终落盘 raw 算——
    // status/owner_ruling/owner-decision 改动已写完）。keeper 读回同一文件复算同款 token 比对；批准后正文/payload
    // 被 pull-swap 换掉即失配 → 不认证。viaTrust 另存（通道限权只认这里）。同 id 覆盖取最后一次裁定（再批即新账）。
    approvals.set(id, {
      token: approvalToken({ id, ruling, decision: approvedDecision, rel: hit.path, kind: hit.kind, content: parseEntryBody(raw).content }),
      viaTrust: viaTrust ?? null,
    });
    // 缺陷2b：复位后刷新派生索引——件现为 status:pending（不再满足隔离-rejected 双条件），updatePage 会
    // DELETE 掉它此前作为 rejected 入的旧行、不再重插。索引在 git 之外、可随时重建，故刷新失败绝不影响复位
    // 落盘，只记日志（与 keeper.refreshIndex 同规矩：索引故障不阻断写路径）。
    if (indexStore) {
      try { indexStore.updatePage(hit.path); }
      catch (e) { console.error(`复位后索引刷新失败（不影响复位）：${e.message}`); }
    }
    const receipt = { id, path: hit.path, status: 'pending', ruling: oneline(ruling), held_at: heldAt, resolved_at: resolvedAt, held_ms: heldMs };
    receipt.synced = writer.commitAndPush({ paths: [hit.path], message: `inbox: 主人裁定 ${id}` });
    return receipt;
  }

  return { addEntry, listEntries, resolveEntry };
}

function oneline(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

// 解析件的正文/keeper 注记/候选块/预批决定——inbox 与 keeper 共用，保证「主人看到的=干净正文」
export function parseEntryBody(raw) {
  const afterFm = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // 干净正文：keeper 注记（\n---\n**keeper …）与机器块之前的部分
  const content = afterFm
    .split(/\n---\n\*\*keeper /)[0]
    .replace(/<!--keeper-options\n[\s\S]*?\n-->/g, '')
    .replace(/<!--owner-decision\n[\s\S]*?\n-->/g, '')
    .trim();
  // 人话原因：最后一条 keeper held/rejected 注记，剥掉原始 JSON 尾巴
  const notes = [...afterFm.matchAll(/\*\*keeper (?:held|rejected)\*\*（[^）]*）：([^\n]*)/g)];
  let reason = notes.length ? notes[notes.length - 1][1] : '';
  reason = reason.split('；keeper 决定')[0].split('{')[0].trim().replace(/[；;]$/, '');
  // 候选方案（最后一个块为准）
  const optBlocks = [...afterFm.matchAll(/<!--keeper-options\n([\s\S]*?)\n-->/g)];
  let options = [];
  if (optBlocks.length) {
    try { options = JSON.parse(optBlocks[optBlocks.length - 1][1]).options ?? []; } catch { options = []; }
  }
  // 主人预批的决定（App 点选后写入）
  const apBlocks = [...afterFm.matchAll(/<!--owner-decision\n([\s\S]*?)\n-->/g)];
  let approvedDecision = null;
  if (apBlocks.length) {
    try { approvedDecision = JSON.parse(apBlocks[apBlocks.length - 1][1]); } catch { approvedDecision = null; }
  }
  return { content, reason, options, approvedDecision };
}
