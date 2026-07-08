# substrate-service

**A long-term memory that every AI you use can share — that stays yours, and stays usable no matter how much you pour in.**

> **一份你所有 AI 都能共享的长期记忆——它始终属于你，而且无论你往里装多少，它都还好用。**

Your context today is scattered across tools, and every new AI you open starts from zero — you re-explain yourself over and over. Worse, the memory you *do* accumulate tends to rot: pile in enough notes with no one keeping order, and a few months later it's an unusable heap. This is one long-term memory your AIs share, kept in order by a tireless librarian that files each new thing where it belongs — so however fast it grows, you can keep adding freely and it stays usable.

> 你的上下文如今散在各个工具里，每开一个新 AI 都从零开始——你一遍遍重新解释自己。更糟的是，你**真攒起来**的那点记忆还容易烂掉：没人维护地往里丢够多，几个月后就是一堆没法用的东西。这是一份**你的 AI 们共享的长期记忆**，由一个不知疲倦的图书管理员替它保持有序、把每样新东西都归到该去的地方——于是无论它长得多快，你都可以不停地加，而它照样好用。

## What it feels like · 用起来像这样

**9 am, on your phone** — you tell your chat assistant: *"Remind me to renew the car registration this week, and save this dumpling place — it was great."*

**11 pm, on your laptop** — you ask your coding agent: *"What's still on my plate this week?"* The registration is in its answer, and the dumpling place is already on your list. You never repeated yourself — every AI you use reads and writes the same memory, and the keeper had already filed each thing where it belongs.

> **早上 9 点，手机上**——对聊天助手说：「提醒我这周去续车牌，另外这家饺子馆记一下，很不错。」
> **晚上 11 点，电脑上**——问编程 agent：「我这周还有啥没做？」——续车牌就在回答里，饺子馆也已经进了清单。你一个字没重复，因为你用的每个 AI 读写的是同一份记忆，keeper 早已把每样东西归到该去的地方。

## What you get · 你能得到什么

**Every AI you use shares it.** Connect Claude, Codex, Hermes — or whatever you reach for next — and it arrives already knowing your preferences, what you've saved, what you're in the middle of. One memory, every tool, no reintroductions.

> **你用的每个 AI 都共享它。** Claude、Codex、Hermes，或你下一个会用的工具——接上来它就知道你的偏好、你存过的东西、你做到一半的事。一份记忆、所有工具、不必重新自我介绍。

**You can pour into it freely — it stays usable.** Saving takes one line and lands instantly; a keeper agent then triages each piece in the background — what belongs in the main store, what stays low-priority, what deserves a whole new category. You get to be careless about adding; the memory stays clean anyway.

> **你尽可以往里猛倒——它照样好用。** 存一条只要一句话、立刻落地；随后由一个 keeper agent 在后台把每一件分拣归档——哪些进主库、哪些留作低优先、哪些值得单开一个新类别。你添加时尽管随意，记忆照样保持干净。

**It's yours to keep — plain files, offline, forever.** The memory is just markdown in a git repo. One `git clone` and you walk away with all of it: readable, offline, not locked in anyone's service. If this project vanished tomorrow, you'd lose nothing.

> **它永远是你的——纯文件、可离线、拿了就走。** 这份记忆就是 git 仓库里的 markdown。一次 `git clone`，全部带走：可读、可离线、不锁在任何人的服务里。哪怕这项目明天消失，你也一条不丢。

**It matters most when a team shares it.** For one person, keeping the memory tidy is a convenience. For a team — dozens of people and their agents all writing into one memory — it's the difference between a shared brain and a swamp: deduping, reconciling who-said-what, flagging what's stale or contradictory. The more people pour in, the more that governing layer earns its keep.

> **多人共享时它才真正见功力。** 对一个人，保持记忆整洁是种便利；对一个团队——几十号人和他们的 agent 同时往一份记忆里写——它就是「共享大脑」和「一潭沼泽」之间的分界：去重、厘清谁说的、标出过时和自相矛盾之处。往里倒的人越多，那层治理越是物有所值。

## Why you can trust it with everything · 为什么你敢把一切都交给它

One design choice holds it all together: **the AI only advises — it never writes your files itself.**

> 一个设计选择撑起这一切：**AI 只出主意——从不亲手写你的文件。**

The keeper reads what comes in and outputs only a *decision* — file it here, hold it, ask you, refuse it — always with a plain reason; ordinary, testable code carries that decision out. Because the model never *acts*, no one can hide an instruction inside a link or a document to make it delete or leak something — a poisoned input, at worst, gets filed away as low-priority. Credentials and secrets are refused before they land, and every read and write is logged with a reason. So you can pour in your most private notes and still see exactly what became of them.

> keeper 读进来的东西，只产出一个「决定」——归这儿、搁置、问你一句、拒收——都附一句人话理由；执行的是一段普通、可测的代码。因为模型从不「动手」，没人能在一个链接或文档里藏一句指令、骗它去删或去泄露——带毒的输入最坏也只是被归为低优先、搁到一边。凭据、密钥在落盘前就被拒收，每一次读写都带理由记录在案。所以你尽可以把最私密的笔记倒进去，也始终看得见它们的下落。

This shape has a name: **Governed Agent Memory** — one long-term memory, many agents (and one day, many people), governed so it stays honest, with you keeping the final say. The full pattern: **[docs/05](docs/05-pattern-gam.md)**.

> 这套东西有个名字：**受治理的 agent 记忆（Governed Agent Memory）**——一份长期记忆、许多 agent（未来还有许多人），受治理以保持诚实，而拍板的始终是你。完整模式见 **[docs/05](docs/05-pattern-gam.md)**。

## How it's different · 它跟别的差在哪

It's **not** another note-taking app, and not one chatbot with memory bolted on. It's the layer *underneath* — the place your data lives, that any AI can plug into.

> **它不是**又一个笔记 app，也不是某一个加了记忆的聊天机器人。它是底下那一层——你数据的归属地，任何 AI 都能接进来。

| | 自带 AI 记忆<br>ChatGPT/Claude | agent 自带记忆<br>Hermes/OpenClaw | 笔记软件<br>Obsidian/Notion | **substrate-service** |
|---|---|---|---|---|
| 谁共享 · who shares | 只有那个 app | 只有那台机上那个 agent | 靠你自己翻 | **你所有的 agent** |
| 谁维护 · who curates | 平台黑箱 | 该 agent 随手记，无共同房规 | 你手动 | **服务端 keeper，按房规强制** |
| 数据归属 · yours? | 锁在平台 | 本地但各存一份、互不相通 | 看 app | **纯 markdown + git，完全是你的** |

**为什么有 MCP 版**：substrate 引擎（[v1](https://github.com/wheam/substrate)）把治理做成「装进每个 agent 的 skill」——威力足，但每接一个 agent 都要装一套 skill、每台机都要 clone 实例、治理靠各 agent 自律。接的 agent 一多，这套「每个都单独配」的税就重了。本项目（v2）把它中心化成一个 MCP 服务：

| | substrate 引擎（v1，skills） | **substrate-service（v2，MCP）** |
|---|---|---|
| 接一个新 agent | 装 ~10 个 skill + clone 实例 | **一段 prompt + 一次性码** |
| 设备本地状态 | 每台机 clone + git 凭据 | **零本地状态，一跳直连** |
| 治理 | 靠各 agent 自律遵守 | **服务端强制，无 agent 能绕** |
| 手机可达 | 纯 skill 模型难 | **服务天生可达** |
| 维护 | 各 agent 自跑 doctor/sync | **keeper + 夜班服务端自动** |

```text
                 you 你
        "save this" 「记一下」
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
 Claude Code   Hermes      Codex …   ← 你的各个 agent，经 MCP 直连
     └────────────┼────────────┘
                  ▼  MCP / capture 端点
     ┌──────────────────────────────────┐
     │  substrate-service                │
     │  ├─ inbox 隔离区（写路径无 LLM，秒回）│
     │  ├─ keeper 守门 agent（只出决定）    │
     │  └─ 你的实例（markdown + git）       │
     └────────────────┬─────────────────┘
                      ▼ push
             GitHub 私库（备份 + 全历史 + 逃生门）
```

## Get it running · 上手运行

两条实测跑通的路径，装的人只挑一条：

- **上云（完整形态，够得着手机 + 远程 fleet）** —— 把 [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 交给你已有的 agent（CC / Codex / Hermes），它按协议帮你在 Railway 搭；或照 [INSTALL_FOR_AGENTS.md §4](INSTALL_FOR_AGENTS.md) 自己手动建。约 $5/月起。
- **本地单机（无云，就这台机器）** —— 一台常开机器上 `node` 或 `docker compose` 一条命令起一份，**约 60 秒就能跑起来**、看懂它怎么工作（跑起来就是完整服务，没有任何时限）。见 **[run-local.md](run-local.md)**。诚实标注：本地形态跨不了设备（手机 / 远程 fleet 要上云）。

### 部署到 Railway

本仓库的 **Dockerfile 在 `service/` 子目录**（`service/Dockerfile`），`COPY` 路径全相对 `service/`，入口是 `docker-entrypoint.sh → node src/server.js`。上 Railway 不管走哪条，都要在向导里确认三件事否则起不来：

1. **Root Directory = `service`** —— 否则 Railway 在仓库根找不到 Dockerfile / `COPY` 对不上，build 失败。（仓库根的 [`railway.json`](railway.json) 声明了 Dockerfile 构建 + `/healthz` 健康检查 + 重启策略；Root Directory 仍需在向导 / 面板里指到 `service`。）
2. **持久卷 mount path = `/data`** —— `DATA_DIR` 默认 `/data`，实例 clone 到 `/data/instance`。
3. **必填环境变量**：`REPO_URL`（实例私有 repo 的 git URL）、`TOKENS_JSON`（客户端 token 表 JSON）。其余变量都有安全默认，**全表 + TOKENS_JSON 格式见 [INSTALL_FOR_AGENTS.md §4/§5](INSTALL_FOR_AGENTS.md)**。`DEEPSEEK_API_KEY` 可选，缺则 keeper 不归档、`recall` 不注册（只读降级）。

### 接入更多 agent —— 真·一段 prompt

装好第一把 primary token 后，再接第 N 个 agent 不用改配置、不用重启：在主频道对 agent 说「铸一个接入码」（`enroll_create`），它回一段可粘贴的 prompt，形如——

```text
读 https://<你的域>/enroll 按协议接入，你的一次性码 abc123…（15 分钟内单次有效）
```

把这段丢给任何新 agent，它自己 `POST /enroll` 换一把专属可吊销 token、按公开协议自配置自验证——零面板操作、零重启。随时 `enroll_revoke` 即刻失效。

<!-- TODO(owner) 真·一键部署 button：Railway 的 one-click 机制是「已发布的模板」→ 链接形如 railway.app/template/<code>。需 owner 先在自己的 Railway 账户里用仓库根的 railway.json 发布一个 template（Railway 站内 New → Deploy a Template），拿到 URL 后回这里放官方 button 链到它，并注明「点完仍须在向导里设 Root Directory=service + 挂 /data 卷 + 填 REPO_URL/TOKENS_JSON」。railway.json 保留（合法且让日后发布模板省事）。 -->

## Daily use · 日常怎么用

装好后用自然语言，agent 会调对应工具：

| 你说 · You say | 工具 · tool | 发生什么 |
|---|---|---|
| 「记一下 / 存进知识库」 | `save` | 落 inbox，keeper 判归哪个 zone |
| 「记住我… / 我的偏好是…」 | `remember` | 落 inbox，归 memory 区 |
| 「收藏这家餐厅 / 加进书单」 | `collections_upsert` | 落 inbox，归收藏 |
| 「加个待办 / 这周还剩啥」 | `todo_add` / `todo_list` | 记 / 列你的待办 |
| 「查我存过的 X / 关于 Y 我知道啥」 | `search` / `recall` | `recall` 出带引用的答案 + gap 提示 |
| 「有哪些待我裁定的」 | `inbox_list` / `inbox_resolve` | 主频道浮出，你一句话裁，自动立判例 |

写入全部先进 inbox 隔离区、由 keeper 审核归档——**受理回执 ≠ 已入库**：agent 只该说「已受理，keeper 会归档」。

## Status · 状态

个人 alpha，作者本人在日用（租户 #1）。里程碑均已上真机：**M0–M3**（只读 MCP + zone ACL + bearer 认证 + 审计 → 写路径 + keeper 守门 → 捕获端点 + iOS App）；**M4.0–M4.8**（仪表 + 判例考卷 / 读侧智能 / lossless 分层 / 主频道 agent / 溯源 + schema 演化 + 审批夜班 / 抗注入 / self-serve 接入）。里程碑与决策记录详见 **[docs/03 §8/§9](docs/03-next-version-spec.md)**。

## Docs · 文档

- **[docs/05 — Governed Agent Memory 模式说明](docs/05-pattern-gam.md)** —— 模式对外版（能单独发出去让人懂）。
- **[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md)** —— 给 agent 的一段安装协议（交给你的 agent，它把服务搭起来）。
- **[run-local.md](run-local.md)** —— 本地单机试用（无云）。
- **[docs/README.md](docs/README.md)** —— 方案与里程碑总览（02 产品化 / 03 下一版 spec / 05 模式说明）。
- 存储层引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)。

## Contributing · 参与开发

- **给服务写代码**：见 **[CONTRIBUTING.md](CONTRIBUTING.md)**（红线、契约先行、判例考卷、异源对抗 review 惯例）。
- **跑测试**：`cd service && npm test`（零依赖离线全绿；判例回归考卷含在内）。

## Repo layout · 目录

```
INSTALL_FOR_AGENTS.md     给 agent 的一段安装协议（交给你的 agent，它把服务搭起来）
run-local.md              本地单机试用（无云）走查
CONTRIBUTING.md           参与开发（红线 / 契约 / 判例考卷 / 异源对抗）
railway.json              Railway 部署契约（Dockerfile 构建 + /healthz 健康检查）
docker-compose.local.yml  本地单机一条命令起（约 60 秒跑起来）
docs/                     方案文档（02 产品化 / 03 spec / 05 模式对外版）
service/                  MCP server（Node 22 + 官方 SDK，service/Dockerfile 部署 Railway；npm test 跑全部测试）
app/                      iOS 捕获 App（/capture 投递端 + 分享扩展，实验件）
```

## License

MIT — 见 [LICENSE](LICENSE)。
