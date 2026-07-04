// MCP server（streamable HTTP，无状态模式）+ bearer 认证 + 审计。
// 每客户端一把 token（TOKENS_JSON），trust 决定 sensitive 区可见性。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTools } from './tools.js';
import { createAudit } from './audit.js';
import { INSTRUCTIONS } from './instructions.js';
import { ensureRepo, pullOnce, startPullLoop } from './repo.js';
import { createWriter } from './writer.js';
import { createInbox } from './inbox.js';
import { createKeeper } from './keeper.js';
import { createNotifier } from './notify.js';
import { createDeepSeekProvider } from './provider.js';

const SERVER_INFO = { name: 'substrate-kb', version: '0.2.0' };

export function createApp({ instanceDir, tokens, audit = createAudit() }) {
  const tools = createTools({ instanceDir });
  const writer = createWriter({ instanceDir });
  const inbox = createInbox({ instanceDir, writer });
  const app = express();
  app.locals.writer = writer; // keeper 与写工具共用同一个单写者
  app.use(express.json({ limit: '1mb' }));

  const state = { startedAt: new Date().toISOString(), lastPull: null };
  app.locals.state = state;

  app.get('/healthz', (_req, res) => res.json({ ok: true, ...state }));

  app.all('/mcp', async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const identity = token && tokens[token];
    if (!identity) {
      audit({ client: null, event: 'auth_rejected', ip: req.headers['x-forwarded-for'] ?? req.ip });
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();

    const server = buildMcpServer({ tools, inbox, identity, audit });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

function buildMcpServer({ tools, inbox, identity, audit }) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const { client, trust } = identity;

  const wrap = (name, fn, render) => async (args) => {
    const t0 = Date.now();
    try {
      const result = await fn({ ...args, trust });
      audit({ client, trust, tool: name, args: auditArgs(args), ok: true, ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: render(result) }] };
    } catch (e) {
      audit({ client, trust, tool: name, args: auditArgs(args), ok: false, error: e.message, ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  };

  const asJson = (r) => JSON.stringify(r, null, 2);

  server.registerTool('search', {
    title: '检索知识库',
    description:
      '在主人的个人知识库做关键词检索（大小写不敏感），返回 路径+行号+片段。主人问「我存过/记过 X 吗」「查查库里有没有」，或回答需要库内佐证时先用它。可选 zone 限定分区。',
    inputSchema: {
      query: z.string().describe('关键词'),
      zone: z.string().optional().describe('限定分区 id（如 todo/knowledge/collections/memory），不传=全库'),
    },
  }, wrap('search', tools.search, asJson));

  server.registerTool('read_page', {
    title: '读一页全文',
    description: '读知识库中某一页的全文，传实例内相对路径（如 knowledge/coffee-brewing.md）。通常先 search 定位再读。',
    inputSchema: { path: z.string().describe('实例内相对路径') },
  }, wrap('read_page', tools.readPage, (r) => r.content));

  if (trust === 'high') {
    server.registerTool('get_context', {
      title: '主人的常驻小抄',
      description: '获取关于主人的常驻上下文：核心事实与偏好、记忆目录、各分区速览与路由。凡问题涉及主人本人（称呼/偏好/背景/环境），先调这个。',
      inputSchema: {},
    }, wrap('get_context', tools.getContext, (r) => r.content));
  }

  server.registerTool('todo_list', {
    title: '主人的待办',
    description: '读主人的待办清单（todo/owner.md）。主人问「我还有什么没做/我的待办」时用。',
    inputSchema: {},
  }, wrap('todo_list', tools.todoList, (r) => r.content));

  server.registerTool('collections_search', {
    title: '查收藏',
    description: '查主人的结构化收藏（行式主表），如 restaurants。name=收藏名，query=关键词（空=全部行）。主人问「我收藏过哪些 X / 我存的餐厅」时用。',
    inputSchema: {
      name: z.string().describe('收藏名（collections/ 下的目录名）'),
      query: z.string().optional().describe('关键词，空=全部'),
    },
  }, wrap('collections_search', tools.collectionsSearch, asJson));

  // ==== 写工具（高信任客户端）：全部只落 inbox 隔离区，keeper 审核后才入库 ====
  if (trust === 'high') {
    const receiptText = (r) => `✅ 已受理 → ${r.path}（状态 pending，keeper 审核后归档并通知主人）`;

    server.registerTool('save', {
      title: '存入知识库（经收件箱）',
      description: '把一段内容存进主人的知识库。当主人说「记一下/存一下/收藏这段」，或你提议保存且主人同意时用。内容落 inbox 隔离区，由 keeper 判断归入哪个分区。hint 可携带你或主人对去向的提示（如「决定」「餐厅」）。',
      inputSchema: {
        content: z.string().describe('要保存的内容原文'),
        hint: z.string().optional().describe('去向提示（可选），如：决定/事实/餐厅/想试'),
      },
    }, wrap('save', async ({ content, hint }) => inbox.addEntry({ kind: 'save', content, hint, client }), receiptText));

    server.registerTool('todo_add', {
      title: '加待办（经收件箱）',
      description: '给主人加一条待办。主人说「记得提醒我/要做 X/加个待办」时用。',
      inputSchema: { item: z.string().describe('待办事项，一句话') },
    }, wrap('todo_add', async ({ item }) => inbox.addEntry({ kind: 'todo', content: item, client }), receiptText));

    server.registerTool('collections_upsert', {
      title: '加收藏条目（经收件箱）',
      description: '往主人的结构化收藏（如 restaurants）加/更新一行。主人说「收藏这家店/加到我的清单」时用。row 的字段尽量对齐该收藏主表的列。',
      inputSchema: {
        name: z.string().describe('收藏名（collections/ 下的目录名）'),
        row: z.record(z.string(), z.any()).describe('结构化字段，如 {name, city, cuisine, notes}'),
      },
    }, wrap('collections_upsert', async ({ name, row }) => inbox.addEntry({ kind: 'collection', payload: { name, row }, client }), receiptText));

    server.registerTool('remember', {
      title: '记住关于主人的事实（经收件箱）',
      description: '记录关于主人的稳定事实/偏好（跨 agent 共享记忆）。主人说「记住我…/我的偏好是…」时用。临时性、一次性的信息不要用这个。',
      inputSchema: { fact: z.string().describe('稳定事实或偏好，一句话') },
    }, wrap('remember', async ({ fact }) => inbox.addEntry({ kind: 'memory', content: fact, client }), receiptText));

    server.registerTool('remove', {
      title: '删除库中内容（经收件箱）',
      description: '删除知识库中的某一页。仅当主人明确要求删除时使用（例：「把 X 那页删了」）——不要因为内容过时/你认为没用就主动删。keeper 会校验目标并执行；git 历史永远可找回；骨架区（governance/skills）禁删。',
      inputSchema: { what: z.string().describe('主人要删什么，原话或页路径（如 knowledge/xxx）') },
    }, wrap('remove', async ({ what }) => inbox.addEntry({ kind: 'remove', content: what, client }), receiptText));

    server.registerTool('inbox_list', {
      title: '查收件箱',
      description: '列出 inbox 收件（含待定夺 held / 被拒收 rejected / 待处理 pending 的件）。主人问「有什么待定夺的/我的收件箱」或要处置某条时先用它拿 id。',
      inputSchema: {},
    }, wrap('inbox_list', async () => inbox.listEntries(), asJson));

    server.registerTool('inbox_resolve', {
      title: '主人裁定收件',
      description: '把主人对某条收件的裁定传给 keeper（例：「这条进 todo」「扔掉别存」「并入 knowledge 的 xxx 页」）。keeper 会按裁定执行并自动把这次纠正记入判例集。仅在主人明确表态后使用，id 用 inbox_list 查。',
      inputSchema: {
        id: z.string().describe('收件 id（inbox_list 可查）'),
        ruling: z.string().describe('主人的裁定原话，一句话'),
      },
    }, wrap('inbox_resolve', async ({ id, ruling }) => inbox.resolveEntry({ id, ruling }),
      (r) => `✅ 裁定已受理（${r.ruling}）→ ${r.path} 复位待 keeper 重判，结果会通知主人并自动立判例`));
  }

  return server;
}

// 审计里长内容截断（日志可读性；全文反正已在 inbox/git 里）
function auditArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + `…(${v.length})` : v;
  }
  return out;
}

// ==== 进程入口（直接运行时）====
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const {
    PORT = 3000,
    DATA_DIR = '/data',
    REPO_URL,
    TOKENS_JSON,
    PULL_INTERVAL_MS = 300_000,
    AUDIT_FILE,
    DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL = 'deepseek-v4-flash',
    DEEPSEEK_ESCALATION_MODEL = 'deepseek-v4-pro',
    FEISHU_WEBHOOK_URL,
    FEISHU_WEBHOOK_SECRET,
    KEEPER_INTERVAL_MS = 60_000,
    KEEPER_MIN_CONFIDENCE = 0.75,
  } = process.env;
  if (!REPO_URL || !TOKENS_JSON) {
    console.error('缺少 REPO_URL / TOKENS_JSON 环境变量');
    process.exit(1);
  }
  const tokens = JSON.parse(TOKENS_JSON);
  const instanceDir = path.join(DATA_DIR, 'instance');
  const audit = createAudit({ file: AUDIT_FILE });

  const { cloned } = await ensureRepo({ repoUrl: REPO_URL, dir: instanceDir });
  console.log(cloned ? `instance cloned → ${instanceDir}` : `instance already present → ${instanceDir}`);

  const app = createApp({ instanceDir, tokens, audit });
  const state = app.locals.state;
  state.lastPull = await pullOnce(instanceDir);
  startPullLoop(instanceDir, Number(PULL_INTERVAL_MS), (result) => {
    state.lastPull = result;
    if (!result.ok) console.error(`pull 失败：${result.error}`);
  });

  if (DEEPSEEK_API_KEY) {
    const notifier = createNotifier({ webhookUrl: FEISHU_WEBHOOK_URL, secret: FEISHU_WEBHOOK_SECRET });
    const provider = createDeepSeekProvider({ apiKey: DEEPSEEK_API_KEY, model: DEEPSEEK_MODEL, escalationModel: DEEPSEEK_ESCALATION_MODEL });
    const keeper = createKeeper({
      instanceDir, writer: app.locals.writer, provider, notifier, audit,
      minConfidence: Number(KEEPER_MIN_CONFIDENCE),
    });
    state.keeper = { enabled: true, model: DEEPSEEK_MODEL, lastRun: null, lastResult: null };
    const tick = () => keeper.processPending()
      .then((r) => { state.keeper.lastRun = new Date().toISOString(); if (!r.skipped) state.keeper.lastResult = r; })
      .catch((e) => console.error(`keeper 循环异常：${e.message}`));
    setTimeout(tick, 5_000); // 启动后先扫一轮
    setInterval(tick, Number(KEEPER_INTERVAL_MS)).unref?.();
    console.log(`keeper enabled（${DEEPSEEK_MODEL} → ${DEEPSEEK_ESCALATION_MODEL}，每 ${KEEPER_INTERVAL_MS}ms）`);
  } else {
    state.keeper = { enabled: false };
    console.log('keeper disabled（缺 DEEPSEEK_API_KEY）');
  }

  app.listen(Number(PORT), () => console.log(`substrate-kb listening on :${PORT}`));
}
