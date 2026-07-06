# substrate-service

**受治理的 agent 记忆（Governed Agent Memory）的开源参考实现。** 给「多个 AI agent 共享同一份长期个人记忆」的一套记忆架构：一切写入先落隔离收件箱、由一个守门 agent（keeper）审核后才入库，正典永远是你能 `git clone` 带走的 markdown + git。它是 [substrate](https://github.com/wheam/substrate) 存储引擎的**服务化访问层**：MCP server + keeper 守门 agent + 捕获端点。

> **怎么部署** —— 两条实测跑通的真实路径（详见下面 [两条装法](#两条装法)）：把 [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 交给你已有的 agent（CC / Codex / Hermes）让它按协议帮你上 Railway，或照 [INSTALL_FOR_AGENTS.md §4](INSTALL_FOR_AGENTS.md) 自己在 Railway 手动建服务；不想上云就走 [本地单机试用](run-local.md)。**上 Railway 不管走哪条都要在向导里确认三件事**否则起不来：**① Root Directory 设为 `service`**（Dockerfile 在 `service/` 子目录）**② 加一个 mount path = `/data` 的持久卷 ③ 填必填环境变量 `REPO_URL` 和 `TOKENS_JSON`**。

<!-- TODO(owner) 真·一键部署 button：Railway 的 one-click 机制是「已发布的模板」→ 链接形如 railway.app/template/<code>，需要 owner 先在自己的 Railway 账户里用仓库根的 railway.json 发布一个 template（Railway 站内 New → Deploy a Template / 从本 repo 发布），拿到 railway.app/template/<code> 的 URL 后再回这里放官方 button 链到它，并注明「点完仍须在向导里设 Root Directory=service + 挂 /data 卷 + 填 REPO_URL/TOKENS_JSON」。此前这里曾挂 railway.app/new/template?template=<repo-url> —— 那不是真机制：Railway 忽略该 param、直接落到通用「New project」页、零 substrate-service 上下文，等于一个静默失败的死按钮，故移除，改为上面两条真实路径。railway.json 保留（合法且让日后发布模板省事）。 -->

## 这是什么

普通「记忆层」让 LLM 直接写你的库；这套模式把 **LLM 降级为「只出主意的顾问」**——它只产出结构化的「决定」，真正的写入永远走一段可测、可回归、可审计的**确定性管线**。于是你能当自己记忆的**作者**，而不是被一堆 agent 悄悄改写。四条特色：

1. **受治理的写入**（keeper 模式）—— 所有写入过一道服务端强制的门（收件箱 → 判断 → 落盘），不是谁想写就写。
2. **可带走的真相 / 主权** —— markdown + git 是唯一真相；`git clone` 即得完整离线副本，不锁在服务里。
3. **agent 中立 + 服务端集中治理** —— 任意支持 MCP 的 agent（Claude Code / Codex / Hermes / …）连上即得同一套读写与规矩。
4. **可审计** —— 每次读写留痕、每次准入有一句人话理由。

模式本身怎么落地，见 → **[docs/05 — Governed Agent Memory 模式说明](docs/05-pattern-gam.md)**（能单独读懂）。

## 两条装法

- **上云（完整形态，够得着手机 + 远程 fleet）** —— 把 [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 交给你已有的 agent（CC / Codex / Hermes），它按协议帮你在 Railway 搭；或照 [INSTALL_FOR_AGENTS.md §4](INSTALL_FOR_AGENTS.md) 自己手动建。约 $5/月起。（真·一键 button 待 owner 发布 Railway 模板后再上，见本文件顶部 TODO。）
- **本地单机（无云，就这台机器）** —— 一台常开机器上 `node` 或 `docker compose` 一条命令起一份，**约 60 秒就能跑起来**、看懂它怎么工作（跑起来就是完整服务，没有任何时限）。见 **[run-local.md](run-local.md)**。诚实标注：本地形态跨不了设备（手机/远程 fleet 要上云）。

### 部署到 Railway

本仓库的 **Dockerfile 在 `service/` 子目录**（`service/Dockerfile`），它的 `COPY` 路径全相对 `service/`，入口是 `docker-entrypoint.sh → node src/server.js`。所以：

1. **Root Directory = `service`** —— 否则 Railway 在仓库根找不到 Dockerfile / `COPY` 对不上，build 失败。（仓库根的 [`railway.json`](railway.json) 声明了 Dockerfile 构建 + `/healthz` 健康检查 + 重启策略；Root Directory 是操作性设置，仍需在向导/面板里指到 `service`。）
2. **持久卷 mount path = `/data`** —— `DATA_DIR` 默认 `/data`，实例 clone 到 `/data/instance`。
3. **必填环境变量**：`REPO_URL`（实例私有 repo 的 git URL）、`TOKENS_JSON`（客户端 token 表 JSON）。其余变量都有安全默认，**全表 + TOKENS_JSON 格式见 [INSTALL_FOR_AGENTS.md §4/§5](INSTALL_FOR_AGENTS.md)**。`DEEPSEEK_API_KEY` 可选，缺则 keeper 不归档、`recall` 不注册（只读降级）。

## 仓库状态

- **M0–M3**（个人 alpha）：✅ 已上真机——连通性实测（定 Railway）、MCP 读工具 + zone ACL + bearer 认证 + 审计、keeper 写通、捕获端点 + iOS App。详见 docs/01。
- **M4.0–M4.2**：✅ 主人已验收——仪表 + 判例考卷（M4.0）、读侧智能（`recall` + 可抛 FTS5 索引 + `content_id`，M4.1）、lossless 分层（`tier` 贯穿写入/检索，M4.2）。
- **M4.3**（主频道 agent + 装 prompt）：✅ 已验收（主人授权编排验证：181 测试绿 + 端到端 15 项实测 + Codex xhigh 两轮对抗 review merge-ready）——主频道 `channel:primary` 标记 + 待裁件主动浮出（piggyback + digest）+ [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 安装协议。
- **M4.4**（溯源 frontmatter + schema 演化 + 审批式夜班）：✅ 已验收（编排验证：244 测试绿 + 考卷 25/25 + 端到端烟雾 18/18 + Codex xhigh **四轮**对抗 review 收敛至 merge-ready）——`source_agent`/`confidence`/`epistemic_type` 落盘；新 zone 提议→主频道点选批→落地 doctor 0 error；夜班确定性扫描出预批维护提案走 inbox。抗注入核心 = 进程内批准登记表（只认 `resolveEntry` 记账的批准，`git pull` 伪造件一律 re-held）。详见 docs/03 §9。
- **M4.5**（抗注入 + 开源打包）：✅ 已验收（编排验证：250 测试绿 + 考卷 45/45 + Codex xhigh 全批 + 两轮聚焦复核 merge-ready）——对抗金标 25→45（adversarial 5→19）；凭据红线四层加固（raw→白空格→`\p{Cf}`→`\p{Mn}/\p{Me}/\p{Cc}`，堵空白/换行/零宽/组合标记隐形拆分）；考卷 confidence 越权假绿修复；Railway 部署双真实路径（agent 驱动装 + 手动 §4，真·一键 button 待 owner 发布模板）、本地单机入口、模式 spec 对外版（docs/05）。详见 docs/03 §9。
- **M4.6**（夜班去人化 + 裁定面按通道收窄）：✅ 已上真机（编排验证：283 测试绿 + 考卷 45/45 + Codex xhigh **两轮**对抗 review 收敛至 merge-ready；真机迁移验证：关闭 3 件遗留删页提案、零内容页误降、零错误）——夜班对薄页/重复页从删页提案改为**非破坏性降级**（`set_tier` canonical→candidate，确定性零裁定、进程内直执行；`set_tier` 被 LLM 决定显式早拒、恢复走高信任 `page_set_tier`）；裁定面按通道收窄（capture 通道只见有权兑现的件，服务端强制「不给人无权兑现的按钮」）；断链等报告落 `governance/maintenance-log.md` + digest 摘要（只带路径/计数、过 `displaySafePath` 单行化防注入）。源于夜班首跑真机复盘：主人被要求裁「做不了判断」的删页提案且裁了被弹回，违反原则 B。详见 docs/03 §9。
- **M4.7**（`collections_search` 读侧修缮）：✅ 已上真机——收藏查询加分页（`limit`/`offset`）、列投影（`columns`）、按列过滤（`where`）、响应字节预算、`truncated` 契约（返回被裁时告知 `next_offset` + 收窄提示，让 agent 自救）；列名 header 白名单防原型污染；向后兼容零破坏。根治 Hermes 查收藏表一把全拉→MCP 返回过大被截断→退化成逐条核对小查询的真机事故。
- **M4.8**（self-serve 接入）：✅ **已上真机**（编排验证：324 测试绿 + 考卷 45/45 + Codex 异源对抗多轮收敛 + 全分支终审 Ready；真机部署验证 2026-07-06 14:30Z：`GET /enroll` 公开协议正常、Host 头注入不污染域名、假码 401、审计 `enroll_rejected` 记 sanitized IP 且审计流零码明文、`invalid` 不通知）——把「接入第 N 个 agent」从手工发 token + 改配置 + 重启，收窄到趋近**一段 prompt / 一个链接**：主频道专属工具 `enroll_create` 铸一次性码 → 新 agent 拿码 `POST /enroll` 换一把专属可吊销 token + 按 `GET /enroll` 公开协议自配置自验证；`TOKENS_JSON` 降级为 bootstrap（起步一把 primary，其余走 enrollment），账本住 volume（git 外、只存 sha256）。可吊销/可审计/权限分级/手机可达/治理全保住。详见 docs/03 §8/§9。

## 文档

- **[docs/05 — Governed Agent Memory 模式说明](docs/05-pattern-gam.md)** —— 模式对外版（能单独发出去让人懂）。
- **[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md)** —— 给 agent 的一段安装协议（交给你的 agent，它把服务搭起来）。
- **[run-local.md](run-local.md)** —— 本地单机试用（无云）。
- **[docs/README.md](docs/README.md)** —— 方案与里程碑总览（01 个人 alpha / 02 产品化 / 03 下一版 spec / 04 团队版 / 05 模式说明）。
- 存储层引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)。

## 目录

```
INSTALL_FOR_AGENTS.md  给 agent 的一段安装协议（交给你的 agent，它把服务搭起来）
run-local.md           本地单机试用（无云）走查
railway.json           Railway 部署契约（Dockerfile 构建 + /healthz 健康检查）
docker-compose.local.yml  本地单机一条命令起（docker compose 路径，约 60 秒跑起来）
docs/       方案文档（含决策记录 + docs/05 模式对外版）
service/    MCP server（Node 22 + 官方 SDK，service/Dockerfile 部署 Railway；npm test 跑全部测试）
app/        iOS 捕获 App（/capture 投递端 + 分享扩展，实验件）
m0-hello/   M0 连通性实测用的最小服务（一次性脚手架，已退役留档）
```
