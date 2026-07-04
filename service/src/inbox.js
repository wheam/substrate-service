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

export function createInbox({ instanceDir, writer }) {
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
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        return {
          id: get('id'), path: `inbox/${f}`, kind: get('kind'), status: get('status'),
          received_at: get('received_at'), hint: get('hint') || undefined,
          excerpt: body.slice(0, 120),
        };
      });
    return { entries };
  }

  // 主人裁定：把件复位为 pending 并携带 owner_ruling，keeper 下一轮按裁定执行并自动立判例
  function resolveEntry({ id, ruling }) {
    const { entries } = listEntries();
    const hit = entries.find((e) => e.id === id);
    if (!hit) {
      throw new Error(`找不到收件 ${id}。当前 inbox 里有：${entries.map((e) => `${e.id}(${e.status})`).join('、') || '（空）'}`);
    }
    if (!ruling?.trim()) throw new Error('ruling 不能为空');
    const abs = path.join(instanceDir, hit.path);
    let raw = readFileSync(abs, 'utf8');
    raw = raw
      .replace(/^status: .*$/m, 'status: pending')
      .replace(/^updated: .*$/m, `updated: ${new Date().toISOString().slice(0, 10)}`)
      .replace(/^owner_ruling: .*\n/m, '');
    raw = raw.replace(/^status: pending$/m, `owner_ruling: ${oneline(ruling)}\nstatus: pending`);
    writeFileSync(abs, raw);
    const receipt = { id, path: hit.path, status: 'pending', ruling: oneline(ruling) };
    receipt.synced = writer.commitAndPush({ paths: [hit.path], message: `inbox: 主人裁定 ${id}` });
    return receipt;
  }

  return { addEntry, listEntries, resolveEntry };
}

function oneline(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}
