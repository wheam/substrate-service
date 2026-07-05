// inbox 隔离区：一切写入先落这里（写路径无 LLM，秒回受理回执），keeper 审核后才进正式区。
// 凭据红线在落盘之前扫——命中即拒收，密钥永不进 git。
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = new Set(['save', 'todo', 'collection', 'memory', 'remove', 'todo_done', 'capture']);

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

export function createInbox({ instanceDir, writer, indexStore = null }) {
  function addEntry({ kind, content = '', hint, client, payload }) {
    if (!KINDS.has(kind)) throw new Error(`未知的 kind：${kind}`);
    const scanTarget = `${content}\n${payload ? JSON.stringify(payload) : ''}\n${hint ?? ''}`;
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(scanTarget)) {
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
      'status: pending',
      '---',
      '',
    ].join('\n');
    const body = payload?.row
      ? '```json\n' + JSON.stringify(payload.row, null, 2) + '\n```\n'
      : content.trim() + '\n';

    mkdirSync(path.join(instanceDir, 'inbox'), { recursive: true });
    writeFileSync(path.join(instanceDir, relPath), fm + body);

    const receipt = { id, path: relPath, status: 'pending' };
    // 落盘即受理；git 同步在后台单写者队列里完成，不阻塞回执
    receipt.synced = writer.commitAndPush({ paths: [relPath], message: `inbox: 收件 ${id} (${kind} via ${client})` });
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
          id: get('id'), path: `inbox/${f}`, kind: get('kind'), status: get('status'),
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
