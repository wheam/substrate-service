// inbox 隔离区：一切写入先落这里（写路径无 LLM，秒回受理回执），keeper 审核后才进正式区。
// 凭据红线在落盘之前扫——命中即拒收，密钥永不进 git。
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containsCredential } from './secrets.js';

// 导出供读路径复验：实例仓库经 git pull 同步，inbox 件可以不经 addEntry、被手工伪造后拉进来——
// 「kind 合法、id 是服务端生成的」只在写路径成立，任何要把 id/kind 拼进响应面的读方必须自己再验。
// schema/maintenance/core = 服务端提案件：创建即 held、直达主人，keeper 不 LLM 判它们（走点选预批通路）。
export const KINDS = new Set(['save', 'todo', 'collection', 'memory', 'remove', 'todo_done', 'capture', 'schema', 'maintenance', 'core']);

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

// inbox_list 预览窗口（listEntries 返回 content.slice(0, N)）。schema payload 提取共用它做「payload 必须完整落在预览窗口内」硬门禁
// （十二轮 Codex）——保证「主人在 inbox_list 预览里看得到的」==「applySchema/schema_apply 实际落地的」，杜绝把 payload 埋在
// 预览截断之外偷偷落地（纯截断 Major）。
export const INBOX_PREVIEW_CHARS = 2000;
// core 草案本身就是待主人审阅的完整可执行 payload，允许到 _core 硬上限 3000 再加固定说明；
// 只给 kind=core 放宽，不扩大普通 capture/schema 的响应面与既有契约。
export const CORE_PROPOSAL_PREVIEW_CHARS = 4000;

// SEC-5（审计 B §4 + 二/三/四轮加固）：【一切】隐藏候选——点选它须件是【服务端亲生且未被篡改】（nativeToken 内容绑定
// 校验命中，见下方 nativeToken；gate 在 resolveEntry 点选分支）。收窄轨迹：二轮只 gate 破坏性删/改页 → 三轮 Codex 指出漏
// schema_apply 等副作用、放宽到「非 forbidden 全 gate」 → 四轮 Codex 指出 forbidden 也非无副作用（主人裁定 reject 会写
// keeper-feedback/_cases.md 判例考卷、被伪造件注入攻击者字段污染 few-shot）→ 收口为【全部候选一律 native】。

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
// SEC-8（审计 B）：client（frontmatter 溯源字段，落进新页 source_agent）原不进 token——批准落定后经 pull 换 client
// 即伪造溯源（不可执行、仅溯源欺骗）。故 client 也绑进哈希（尾部追加）；client 是 resolveEntry 从不改写的稳定字段，
// 绑它安全；swap client → 哈希失配 → 不认证 → re-held。两处调用点（resolveEntry 记账 / keeper 复算）须同源传值。
export function approvalToken({ id, ruling, decision, rel = '', kind = '', content = '', client = '' }) {
  const norm = `${id}\n${oneline(ruling)}\n${decision ? JSON.stringify(decision) : ''}\n${rel}\n${kind}\n${content}\n${client}`;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

// native token 的绑定材料：干净正文（parseEntryBody.content，截在首个 keeper 注记前）+ 最后一个 keeper-options
// 块【原文】。两者跨 keeper 注记稳定——rewriteEntry 追加的 `\n---\n**keeper …` 注记落在 content 截断点之后、
// 也不在 options 正则的目标块内；故同一件在「addEntry 写盘 → keeper 复算 → resolveEntry 复算」三处算出同一 token。
// 绑 options【原文子串】（而非 parse→再 stringify）避免序列化归一漂移，三处按同一 fileText/raw 取到逐字节相同的块。
function nativeBindMaterial(raw) {
  const s = String(raw ?? '');
  const content = parseEntryBody(s).content;
  const optBlocks = [...s.matchAll(/<!--keeper-options\r?\n([\s\S]*?)\r?\n-->/g)];
  const optionsRaw = optBlocks.length ? optBlocks[optBlocks.length - 1][1] : '';
  return { content, optionsRaw };
}

// SEC-2/SEC-5 加固（审计 B 二轮 + Codex 异源对抗 review 实证）：服务端亲生件的【内容绑定】token。
// 为什么不能只按 id 判定 native（一轮 Set<id> 的洞）：inbox 件 id 是【公开的】——addEntry 落盘即 commit+push、
// git log 可见。攻击者复用任意历史 native id 伪造 `kind:remove` 件即命中「id 集合」→ 绕过 SEC-2 零交互删页；
// 当前 native held 件的 options 被 git pull 篡改（id 不变）后仍过 SEC-5 gate（PoC 均实证要害页被删）。
// 补法：native 绑 id+rel+kind+client+干净正文+options 原文——伪造件即便复用 id，只要 rel/kind/正文/options 任一
// 不同即 token 失配 → 非 native；复用得【逐字节完全一致】才命中，但那等于重放主人原本就授权的同一动作
// （re-delete 已删页=no-op / 同一 options 同一选择），无新增能力。与 approvalToken 同族、同 parseEntryBody 归一。
export function nativeToken({ id, rel = '', kind = '', client = '', raw = '' }) {
  const { content, optionsRaw } = nativeBindMaterial(raw);
  const norm = `${id}\n${rel}\n${normKind(kind)}\n${oneline(client)}\n${content}\n${optionsRaw}`;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

// nativeReg（进程内 Map<id, nativeToken>）：语义/重启行为同 approvals 登记表（进程内、重启即空、安全失败）。
// addEntry 记账（id→token）、keeper/resolveEntry 复算比对、终态（filed / 主人裁定清场）删账。createApp 建这一个
// Map、经 app.locals.nativeReg 同时给 inbox 与 keeper/nightly（缺省 new Map()：单独构造的 inbox 记的账无人核验
// = 安全失败，不会误放行）。
export function createInbox({ instanceDir, writer, indexStore = null, approvals = new Map(), nativeReg = new Map() }) {
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
    if (containsCredential(scanTarget)) {
      throw new Error('拒收：内容含疑似密钥/凭据（红线：密钥原文绝不进库）。请脱敏后重试。');
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
      : neutralizeMachineMarkers(content.trim()) + '\n';
    // 预批候选块：与 keeper held 写的 <!--keeper-options--> 同形状，parseEntryBody 照常读回、resolveEntry({option}) 照常点选。
    if (optionsBlock) body += `\n<!--keeper-options\n${JSON.stringify(optionsBlock)}\n-->\n`;

    const abs = path.join(instanceDir, relPath);
    const fileText = fm + body;
    // SEC-2/SEC-5 加固：登记「服务端亲生件」的【内容绑定】token——按最终写盘文本算（keeper/resolveEntry 读回
    // 同一文本复算同款 token 命中即 native；被 git pull 换掉正文/kind/options 即失配 → 非 native）。伪造件从不
    // 经 addEntry、复用公开 id 也因内容不符而失配。见 nativeToken 注释。语义/重启同 approvals（进程内、重启即空）。
    nativeReg.set(id, nativeToken({ id, rel: relPath, kind, client, raw: fileText }));
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
        const kind = normKind(get('kind'));
        const id = get('id');
        const rel = `inbox/${f}`;
        const client = get('client');
        // core 的 4k 专用预览只给本进程服务端亲生且未被篡改的提案。伪造件、以及重启后失去 native
        // 登记的旧件仍只回普通 2k，避免攻击者仅靠手写 kind:core 扩大提示注入响应面。
        const nativeCore = kind === 'core' && nativeReg.get(id) === nativeToken({ id, rel, kind, client, raw });
        return {
          id, path: rel, kind, status: get('status'),
          received_at: get('received_at'), hint: get('hint') || undefined,
          client, excerpt: parsed.content.slice(0, 120),
          content: parsed.content.slice(0, nativeCore ? CORE_PROPOSAL_PREVIEW_CHARS : INBOX_PREVIEW_CHARS),
          reason: parsed.reason, options: parsed.options.map((o, i) => ({ index: i, label: o.label })),
        };
      });
    return { entries };
  }

  // 主人裁定：把件复位为 pending 并携带 owner_ruling，keeper 下一轮按裁定执行并自动立判例。
  // via/viaTrust 记录裁定进来的通道——capture 通道的裁定在执行层被限权（如无权删页）。
  function resolveEntry({ id, ruling, option, via, viaTrust, viaChannel }) {
    const { entries } = listEntries();
    const hit = entries.find((e) => e.id === id);
    if (!hit) {
      throw new Error(`找不到收件 ${id}。当前 inbox 里有：${entries.map((e) => `${e.id}(${e.status})`).join('、') || '（空）'}`);
    }
    const abs = path.join(instanceDir, hit.path);
    let approvedDecision = null;
    if (option !== undefined && option !== null) {
      // 点选候选方案：取出该方案的完整决定作为预批，keeper 直接执行不再重判
      const optRaw = readFileSync(abs, 'utf8');
      const parsed = parseEntryBody(optRaw);
      const chosen = parsed.options[Number(option)];
      if (!chosen) throw new Error(`没有候选方案 #${option}（共 ${parsed.options.length} 个）`);
      // SEC-5（审计 B §4 + 二/三/四轮加固）：【一切】候选点选只允许在【内容绑定 native】件上——即当前文件（含 options 块）
      // 的 nativeToken 与登记值逐字节一致。四轮收口为「全部候选一律 native」，不再给 forbidden 开口子：forbidden 并非无
      // 副作用——主人裁定的 reject 会 appendCase 写 keeper-feedback/_cases.md（＝keeper 的判例考卷/few-shot 材料）；伪造件
      // forbidden 候选把攻击者的 zone/action/target 注入判例日志＝对未来 keeper 决策的提示注入。
      // 攻击：push 伪造 held 件（options label「扔掉别存/扔掉别建」而隐藏 decision 实为删/改要害页 / schema_apply 建攻击者
      // zone / 污染判例）→ 主人只看 label → 点它 → 隐藏决定被记成【认证过的批准】（F1 挡不住、主人确实点了）→ keeper 因
      // kind≠maintenance 跳过 F2 交叉校验 → 副作用落地或判例被污染。一/二/三轮逐步收窄 gate（id→内容绑定→非 forbidden 全
      // gate），四轮收口为全部候选一律 native。
      // 一轮只按 id 判 native 被公开 id 复用打穿（Codex/自验 PoC）；此处内容绑定校验——伪造件复用 id 但正文/options 不符
      // → 失配；【当前 native held 件的 options 被 git pull 篡改】（id 不变）→ 重算 token 与登记值不符 → 同样拒。
      // 合法候选只在亲生且未篡改件上出现。重启语义：nativeReg 进程内、重启即空——重启后合法 held 件的候选点选会被挡；
      // 主人可改用文字裁定（无 option、keeper 重判、非攻击者可控）表达丢弃/裁决，或重新触发。安全失败、同 approvals。
      if (nativeReg.get(id) !== nativeToken({ id, rel: hit.path, kind: hit.kind, client: hit.client, raw: optRaw })) {
        throw new Error('该件疑似伪造或被篡改（内容绑定校验不符），拒绝点选候选——请复核来源或改用文字裁定');
      }
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
      // SEC-8（审计 B）：token 追加 client=hit.client（与 keeper 复算处 entry.client 同源同值）——绑溯源字段，
      // 防 approve-then-swap 改 client 伪造新页 source_agent。
      token: approvalToken({ id, ruling, decision: approvedDecision, rel: hit.path, kind: hit.kind, content: parseEntryBody(raw).content, client: hit.client }),
      viaTrust: viaTrust ?? null,
      viaChannel: viaChannel ?? null,
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

// 八轮 Codex Major：机器块（<!--keeper-options-->/<!--owner-decision-->）只能由服务端 addEntry(optionsBlock)/keeper.holdEntry
// 生成。用户/capture 正文若自带一个，listEntries 会把用户伪造的候选 label 展示、nativeToken 又把这段【用户自带】optionsRaw
// 绑成「亲生」——resolveEntry 点选即零 LLM 执行隐藏 decision（native gate 挡不住：件确实是服务端写盘的亲生件）。故写盘前把用户
// 正文里的机器块起始标记中和成可见字面量（&lt;!--…）：既非注释、也不被 options 正则解析，主人反而看得见。合法用户绝不会写这个
// 内部标记，中和只影响伪造/越权内容。
function neutralizeMachineMarkers(text) {
  return String(text).replace(/<!--(\s*(?:keeper-options|owner-decision))/gi, '&lt;!--$1');
}

// 单趟【三态】扫描器：把文本切成有序 segments（kind: 'text' | 'comment' | 'fence'），拼接 [start,end) == 原文。
// inbox 与 executor 共用【同一套】fence/comment 语义（七轮 Codex：别让两处各维护一套不一致状态机——否则一处认围栏、另一处
// 不认，就是绕过面）。规则：
//   · 行级 backtick 代码围栏——行首≤3 空格 + ≥3 backtick + info 无 backtick 开栏；同 ≤3 空格 + ≥开栏长度 backtick + 仅尾随空白
//     闭栏；未闭合延到 EOF。围栏【不嵌套】（第一条足够长的纯 backtick 行即闭栏），故外层非-json 围栏里的字面量 ```json 只是其
//     文本、不是独立围栏。
//   · HTML 注释 <!-- … -->（未闭合吃到 EOF）。注释与围栏【先遇者优先、同一趟切分】——注释内的 ```json 绝不当围栏、围栏内的
//     <!-- 绝不当注释。
// fence 段带 info（开栏 info string，如 'json'）与 innerStart/innerEnd（围栏内内容范围）。
export function scanSegments(s) {
  const n = s.length;
  const segs = [];
  let i = 0, textStart = 0;
  const lineEndOf = (k) => { let q = k; while (q < n && s[q] !== '\n') q++; return q; };
  // 八轮 Codex：fence marker 字符须支持 backtick 与 tilde 两种（CommonMark/GFM）。否则 `~~~` 外层围栏不被识别 →
  // 里面的字面量 ```json 被 schema 提取器当成 top-level payload 落地 evil zone。闭栏必须【同字符】、长度≥开栏、仅尾随空白。
  const fenceAt = (k) => {
    let p = k, sp = 0;
    while (s[p] === ' ' && sp < 4) { p++; sp++; }
    if (sp > 3) return null;
    const ch = s[p];
    if (ch !== '`' && ch !== '~') return null;
    let ticks = 0; while (s[p] === ch) { p++; ticks++; }
    if (ticks < 3) return null;
    const le = lineEndOf(p);
    return { ch, ticks, lineEnd: le, rest: s.slice(p, le).replace(/\r$/, '') };
  };
  const flush = (end) => { if (end > textStart) segs.push({ kind: 'text', start: textStart, end }); };
  while (i < n) {
    if (i === 0 || s[i - 1] === '\n') { // 只在行首判围栏
      const f = fenceAt(i);
      if (f && !f.rest.includes(f.ch)) { // 开栏（info 不含 fence 字符）
        flush(i);
        const info = f.rest.trim();
        const innerStart = f.lineEnd < n ? f.lineEnd + 1 : n;
        let j = innerStart, closeStart = -1, closeLineEnd = -1;
        while (j < n) {
          const g = (j === 0 || s[j - 1] === '\n') ? fenceAt(j) : null;
          if (g && g.ch === f.ch && g.ticks >= f.ticks && g.rest.trim() === '') { closeStart = j; closeLineEnd = g.lineEnd; break; } // 闭栏须同字符
          const le = lineEndOf(j); j = le < n ? le + 1 : n;
        }
        const end = closeStart === -1 ? n : (closeLineEnd < n ? closeLineEnd + 1 : n);
        segs.push({ kind: 'fence', info, start: i, end, innerStart, innerEnd: closeStart === -1 ? n : closeStart });
        i = end; textStart = end; continue;
      }
    }
    if (s.startsWith('<!--', i)) { // 围栏外注释
      flush(i);
      const e = s.indexOf('-->', i + 4);
      const end = e === -1 ? n : e + 3; // 未闭合 → 吃到 EOF
      segs.push({ kind: 'comment', start: i, end });
      i = end; textStart = end; continue;
    }
    i++;
  }
  flush(n);
  return segs;
}

// 剥掉【围栏外】的一切 HTML 注释，围栏内内容逐字节保留（drop comment 段、text/fence 段原样拼回）。
function stripHtmlCommentsOutsideFences(s) {
  let out = '';
  for (const seg of scanSegments(s)) if (seg.kind !== 'comment') out += s.slice(seg.start, seg.end);
  return out;
}

// 解析件的正文/keeper 注记/候选块/预批决定——inbox 与 keeper 共用，保证「主人看到的=干净正文」
export function parseEntryBody(raw) {
  // 四轮加固（Codex 异源）：机器块正则一律 \r?\n 口径——CRLF 版隐藏块（git pull 可伪造）早先漏剥、残留进 content，
  // 被 extractSchemaPayload 取到偷换 schema payload。LF 件行为不变（\r? 可选），仅让 CRLF 伪造件也被正确剥离。
  const afterFm = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // 干净正文：先切掉 keeper 注记（\n---\n**keeper …），再剥【围栏外的一切 HTML 注释】（含机器块 keeper-options/
  // owner-decision）。五/六轮 Codex 逐步逼出的根因：content 既喂 keeper LLM 提示、又当 approvalToken/nativeToken 绑定料、
  // 又进 appendCase 判例；HTML 注释对渲染后的主人不可见却对 keeper 可见——任何注释（裸 <!--、任意名、未闭合）都是 prompt
  // 注入/判例污染面。前四轮用「机器名 + \r?\n + 未闭合」堆正则总有变体漏网，故统一改 stripHtmlCommentsOutsideFences：
  // 围栏外注释一律剥、围栏内 verbatim（不误伤 JSON 串里的 <!--…-->）。
  // scanBody = 切掉 keeper 注记后的正文，【注释保持原样】（未剥）。content 在它上面再剥注释供展示/绑定/keeper 提示；
  // 但 schema 提取【必须】在 scanBody（注释未剥）上跑 scanSegments——九轮 Codex：若在【剥完注释】的 content 上找围栏，删注释
  // 会把 ``<!--x-->`json 相邻字符拼成一个原文并不存在的 ```json 活动围栏、被当 payload 落地 evil。注释未剥则 scanSegments
  // 正确把它切成 comment 段、不合成围栏。
  const scanBody = afterFm.split(/\r?\n---\r?\n\*\*keeper /)[0];
  const content = stripHtmlCommentsOutsideFences(scanBody).trim();
  // 人话原因：最后一条 keeper held/rejected 注记，剥掉原始 JSON 尾巴
  const notes = [...afterFm.matchAll(/\*\*keeper (?:held|rejected)\*\*（[^）]*）：([^\r\n]*)/g)];
  let reason = notes.length ? notes[notes.length - 1][1] : '';
  reason = reason.split('；keeper 决定')[0].split('{')[0].trim().replace(/[；;]$/, '');
  // 候选方案（最后一个块为准）
  const optBlocks = [...afterFm.matchAll(/<!--keeper-options\r?\n([\s\S]*?)\r?\n-->/g)];
  let options = [];
  if (optBlocks.length) {
    try { options = JSON.parse(optBlocks[optBlocks.length - 1][1]).options ?? []; } catch { options = []; }
  }
  // 主人预批的决定（App 点选后写入）
  const apBlocks = [...afterFm.matchAll(/<!--owner-decision\r?\n([\s\S]*?)\r?\n-->/g)];
  let approvedDecision = null;
  if (apBlocks.length) {
    try { approvedDecision = JSON.parse(apBlocks[apBlocks.length - 1][1]); } catch { approvedDecision = null; }
  }
  return { content, reason, options, approvedDecision, scanBody };
}
