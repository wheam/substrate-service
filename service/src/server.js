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

const SERVER_INFO = { name: 'substrate-kb', version: '0.1.0' };

export function createApp({ instanceDir, tokens, audit = createAudit() }) {
  const tools = createTools({ instanceDir });
  const app = express();
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

    const server = buildMcpServer({ tools, identity, audit });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

function buildMcpServer({ tools, identity, audit }) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const { client, trust } = identity;

  const wrap = (name, fn, render) => async (args) => {
    const t0 = Date.now();
    try {
      const result = await fn({ ...args, trust });
      audit({ client, trust, tool: name, args, ok: true, ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: render(result) }] };
    } catch (e) {
      audit({ client, trust, tool: name, args, ok: false, error: e.message, ms: Date.now() - t0 });
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

  server.registerTool('get_context', {
    title: '主人的常驻小抄',
    description: '获取关于主人的常驻上下文：核心事实与偏好、记忆目录、各分区速览与路由。凡问题涉及主人本人（称呼/偏好/背景/环境），先调这个。',
    inputSchema: {},
  }, wrap('get_context', tools.getContext, (r) => r.content));

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

  return server;
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

  app.listen(Number(PORT), () => console.log(`substrate-kb listening on :${PORT}`));
}
