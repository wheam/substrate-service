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

For a personal instance with only a few trusted agents, an opt-in **light-governance mode** lets those clients create or append an explicitly named ordinary page after deterministic checks and doctor, while ambiguous and high-risk work still goes through the keeper. See [docs/07](docs/07-light-governance.md).

> 如果个人实例只有少数可信 agent，可选择开启**轻治理模式**：明确目标的普通页新建/追加经过确定性校验和 doctor 后直接落库；目标不明和高风险操作仍交给 keeper。详见 [docs/07](docs/07-light-governance.md)。

**It's yours to keep — plain files, offline, forever.** The memory is just markdown in a git repo. One `git clone` and you walk away with all of it: readable, offline, not locked in anyone's service. If this project vanished tomorrow, you'd lose nothing.

> **它永远是你的——纯文件、可离线、拿了就走。** 这份记忆就是 git 仓库里的 markdown。一次 `git clone`，全部带走：可读、可离线、不锁在任何人的服务里。哪怕这项目明天消失，你也一条不丢。

**It matters most when a team shares it.** For one person, keeping the memory tidy is a convenience. For a team — dozens of people and their agents all writing into one memory — it's the difference between a shared brain and a swamp: deduping, reconciling who-said-what, flagging what's stale or contradictory. The more people pour in, the more that governing layer earns its keep.

> **多人共享时它才真正见功力。** 对一个人，保持记忆整洁是种便利；对一个团队——几十号人和他们的 agent 同时往一份记忆里写——它就是「共享大脑」和「一潭沼泽」之间的分界：去重、厘清谁说的、标出过时和自相矛盾之处。往里倒的人越多，那层治理越是物有所值。

## How it earns trust · 它怎样建立信任

One design choice holds it all together: **an AI never gets raw filesystem access — bounded, testable code performs every write.**

> 一个设计选择撑起这一切：**AI 永远拿不到裸文件系统权限——每次写入都由有界、可测的代码执行。**

In the default path, the keeper reads what comes in and outputs only a *decision* — file it here, hold it, ask you, refuse it — while ordinary code carries that decision out. In opt-in light mode, a trusted client may request only an explicit ordinary-page create or append; the same allow-listed policy, credential scan, doctor, Git transaction and rollback still apply. Recognized credential patterns are refused before they land, and audits record metadata without copying private write content or credentials. This does not make any hosted system risk-free, but it limits the available effects and leaves a visible trail.

> 默认路径里，keeper 读进来的东西只产出一个「决定」——归这儿、搁置、问你一句、拒收；普通白名单代码才执行。轻治理模式里，可信客户端也只能请求明确普通页的 create/append，仍经过同一套 effect policy、凭据扫描、doctor、Git 事务和回滚。审计只记元数据、不复制私人正文或凭据。这不代表托管系统零风险，但它限制了可用副作用，并留下可查轨迹。

This shape has a name: **Governed Agent Memory** — one long-term memory, many agents (and one day, many people), governed so it stays honest, with you keeping the final say. The full pattern: **[docs/05](docs/05-pattern-gam.md)**.

> 这套东西有个名字：**受治理的 agent 记忆（Governed Agent Memory）**——一份长期记忆、许多 agent（未来还有许多人），受治理以保持诚实，而拍板的始终是你。完整模式见 **[docs/05](docs/05-pattern-gam.md)**。

## How it's different · 它跟别的差在哪

It's **not** another note-taking app, and not one chatbot with memory bolted on. It's the layer *underneath* — the place your data lives, that any AI can plug into.

> **它不是**又一个笔记 app，也不是某一个加了记忆的聊天机器人。它是底下那一层——你数据的归属地，任何 AI 都能接进来。

| | Built-in AI memory<br>ChatGPT/Claude | Agent-local memory<br>Hermes/OpenClaw | Note-taking apps<br>Obsidian/Notion | **substrate-service** |
|---|---|---|---|---|
| Who shares it? | That app only | That agent on that machine | You search it yourself | **All of your agents** |
| Who curates it? | Platform black box | Each agent writes ad hoc, with no shared rules | You do it manually | **Server-side policy; keeper for ambiguous/risky work** |
| Who owns the data? | Locked into the platform | Local, but fragmented across agents | Depends on the app | **Plain markdown + git, fully yours** |

> | | AI 自带记忆<br>ChatGPT/Claude | agent 本地记忆<br>Hermes/OpenClaw | 笔记软件<br>Obsidian/Notion | **substrate-service** |
> |---|---|---|---|---|
> | 谁共享？ | 只有那个 app | 只有那台机器上的那个 agent | 靠你自己翻 | **你所有的 agent** |
> | 谁维护？ | 平台黑箱 | 各 agent 随手记，没有共同房规 | 你手动维护 | **服务端强制边界；keeper 处理歧义和高风险** |
> | 数据归谁？ | 锁在平台里 | 虽在本地，却散落在各 agent 中 | 取决于 app | **纯 markdown + git，完全属于你** |

**Why an MCP version?** The substrate engine ([v1](https://github.com/wheam/substrate)) packages governance as skills installed into each agent. It is powerful, but every new agent needs the skills, every machine needs a clone of the instance, and governance depends on each agent following the rules. That per-agent setup tax grows quickly. This project (v2) centralizes the same idea as an MCP service:

> **为什么要做 MCP 版？** substrate 引擎（[v1](https://github.com/wheam/substrate)）把治理做成安装进每个 agent 的 skills。它威力足，但每接一个 agent 都要装 skills，每台机器都要 clone 实例，治理也依赖各 agent 自觉守规矩。agent 一多，这笔逐个配置的成本就会迅速变重。本项目（v2）把同一套思路集中成一个 MCP 服务：

| | substrate engine (v1, skills) | **substrate-service (v2, MCP)** |
|---|---|---|
| Add a new agent | Install ~10 skills + clone the instance | **One prompt + a one-time code** |
| Local device state | A clone + git credentials on every machine | **No local state; connect directly** |
| Governance | Each agent must follow the rules voluntarily | **Effect boundaries enforced server-side; keeper strict by default, light mode opt-in** |
| Phone access | Awkward with a skills-only model | **Naturally reachable as a service** |
| Maintenance | Every agent runs doctor/sync itself | **Automated by the keeper and nightly jobs** |

> | | substrate 引擎（v1，skills） | **substrate-service（v2，MCP）** |
> |---|---|---|
> | 接一个新 agent | 安装约 10 个 skill + clone 实例 | **一段 prompt + 一个一次性码** |
> | 设备本地状态 | 每台机器都要有 clone + git 凭据 | **零本地状态，直接连接** |
> | 治理 | 靠各 agent 自觉遵守 | **副作用边界服务端强制；默认 Keeper，轻治理需显式授权** |
> | 手机可达 | 纯 skills 模型较难 | **服务天然可达** |
> | 维护 | 各 agent 自己运行 doctor/sync | **keeper + 夜间任务自动完成** |

```text
                  you
             "save this"
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
 Claude Code    Hermes       Codex …   ← your agents, connected over MCP
      └────────────┼────────────┘
                   ▼  MCP / capture endpoint
      ┌─────────────────────────────────┐
      │  substrate-service              │
      │  ├─ deterministic trusted-direct lane (opt-in)
      │  ├─ isolated inbox (default / ambiguous writes)
      │  ├─ keeper agent (decides, never writes directly)
      │  └─ your instance (markdown + git)
      └────────────────┬────────────────┘
                       ▼ push
          private GitHub repo (backup + history + exit hatch)
```

> ```text
>                  你
>               「记一下」
>                   │
>      ┌────────────┼────────────┐
>      ▼            ▼            ▼
> Claude Code    Hermes       Codex …   ← 你的各个 agent，通过 MCP 直连
>      └────────────┼────────────┘
>                   ▼  MCP / capture 端点
>      ┌─────────────────────────────────┐
>      │  substrate-service              │
>      │  ├─ 确定性可信直写通道（显式开启）
>      │  ├─ inbox 隔离区（默认 / 目标不明的写入）
>      │  ├─ keeper 守门 agent（只作决定，不直接写文件）
>      │  └─ 你的实例（markdown + git）
>      └────────────────┬────────────────┘
>                       ▼ push
>          GitHub 私有仓库（备份 + 完整历史 + 退出通道）
> ```

## Get it running · 上手运行

There are two tested ways to run it. Pick one:

- **Cloud (the full setup, reachable from phones and remote agents)** — use the Railway template below, or hand [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) to an agent you already use (Claude Code / Codex / Hermes). Starts at roughly $5/month.
- **One local machine (no cloud)** — start the complete service with one `node` or `docker compose` command on an always-on machine. It takes **about 60 seconds** and has no trial limit. See **[run-local.md](run-local.md)**. The tradeoff: local-only mode does not reach across devices; phones and remote agents need the cloud setup.

> 有两条实测跑通的路径，选择一条即可：
>
> - **上云（完整形态，手机和远程 agent 都能访问）**——点击下面的 Railway 模板，或把 [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 交给你已经在用的 agent（Claude Code / Codex / Hermes）代办。费用约每月 5 美元起。
> - **本地单机（不用云）**——在一台常开机器上，用一条 `node` 或 `docker compose` 命令启动完整服务，**约 60 秒即可跑起来**，也没有试用时限。参见 **[run-local.md](run-local.md)**。需要说明的是：本地模式无法跨设备，手机和远程 agent 仍需使用云端部署。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/AlyM7t)

### Deploy to Railway · 部署到 Railway

This repository keeps its **Dockerfile in the `service/` subdirectory** (`service/Dockerfile`). Every `COPY` path is relative to `service/`, and the entrypoint is `docker-entrypoint.sh → node src/server.js`. Whichever Railway path you use, confirm these three settings or the service will not start:

1. **Root Directory = `service`** — otherwise Railway looks for the Dockerfile at the repository root, the `COPY` paths do not line up, and the build fails. The root [`railway.json`](railway.json) declares Dockerfile builds, the `/healthz` check, and the restart policy; Root Directory must still point to `service` in the wizard or dashboard.
2. **Persistent volume mount path = `/data`** — `DATA_DIR` defaults to `/data`, and the instance is cloned into `/data/instance`.
3. **Required environment variables** — `REPO_URL` (the git URL of your private instance repository) and `TOKENS_JSON` (the client-token table as JSON). Every other variable has a safe default; see **[INSTALL_FOR_AGENTS.md §4/§5](INSTALL_FOR_AGENTS.md)** for the full list and the `TOKENS_JSON` format. `DEEPSEEK_API_KEY` is optional. Without it, the keeper does not file inbox items and `recall` is not registered; explicitly authorized trusted-direct writes still work.

> 本仓库的 **Dockerfile 位于 `service/` 子目录**（`service/Dockerfile`）。所有 `COPY` 路径都相对 `service/`，入口为 `docker-entrypoint.sh → node src/server.js`。无论通过哪种方式部署到 Railway，都要确认下面三项，否则服务无法启动：
>
> 1. **Root Directory = `service`**——否则 Railway 会在仓库根目录查找 Dockerfile，`COPY` 路径也会错位，最终导致构建失败。仓库根目录的 [`railway.json`](railway.json) 已声明 Dockerfile 构建、`/healthz` 健康检查和重启策略；但仍需在向导或控制台中把 Root Directory 指向 `service`。
> 2. **持久卷挂载路径 = `/data`**——`DATA_DIR` 默认为 `/data`，实例会被 clone 到 `/data/instance`。
> 3. **必填环境变量**——`REPO_URL`（实例私有仓库的 git URL）和 `TOKENS_JSON`（JSON 格式的客户端 token 表）。其他变量都有安全默认值；完整列表和 `TOKENS_JSON` 格式参见 **[INSTALL_FOR_AGENTS.md §4/§5](INSTALL_FOR_AGENTS.md)**。`DEEPSEEK_API_KEY` 为可选项；不提供时 keeper 不执行 inbox 归档，`recall` 也不会注册；显式授权的可信直写仍可工作。

### Connect more agents with one prompt · 用一段 prompt 接入更多 agent

Once the first primary token is installed, adding the next agent requires no configuration change or restart. In the primary channel, ask an agent to “mint an enrollment code” (`enroll_create`). It returns a paste-ready prompt like this:

> 安装好第一把 primary token 后，再接入任何新 agent 都不需要修改配置或重启。在主频道让 agent「生成一个接入码」（`enroll_create`），它会返回一段可以直接粘贴的 prompt，例如：

```text
Read https://<your-domain>/enroll and follow the protocol. Your one-time code is abc123… (single use, expires in 15 minutes).
```

> ```text
> 读取 https://<你的域名>/enroll 并按协议接入。你的一次性码是 abc123……（仅可使用一次，15 分钟后过期）。
> ```

Give that prompt to any new agent. It calls `POST /enroll` to exchange the code for its own revocable token, then configures and verifies itself against the public protocol — no dashboard work and no restart. Use `enroll_revoke` to disable it immediately at any time.

> 把这段 prompt 交给任何新 agent。它会调用 `POST /enroll`，用接入码换取一把专属、可吊销的 token，再按照公开协议自行配置和验证——不用操作控制台，也不用重启。你可以随时调用 `enroll_revoke` 让它立即失效。

## Daily use · 日常怎么用

Once installed, use natural language and let your agent call the matching tool:

| You say | Tool | What happens |
|---|---|---|
| “Save this / put this in my knowledge base” | `save` | Default: inbox; trusted-direct clients may create/append an explicit ordinary page immediately |
| “Remember that I… / my preference is…” | `remember` | Lands in the inbox and is filed under memory |
| “Save this restaurant / add this to my reading list” | `collections_upsert` | Lands in the inbox and is filed as a collection item |
| “Add a task / what is left this week?” | `todo_add` / `todo_list` | Adds or lists your tasks |
| “Find what I saved about X / what do I know about Y?” | `search` / `recall` | `recall` answers with citations and gap hints |
| “What is waiting for my decision?” | `inbox_list` / `inbox_resolve` | Surfaces cases in the primary channel; your ruling becomes precedent |
| “Review and promote this staged Skill” | `skill_inspect` / `promote_skill` / `inbox_resolve` | Binds approval to the complete staged tree, then atomically promotes it; ordinary `save` cannot write a new canonical Skill |

> 安装完成后，直接使用自然语言，agent 会调用相应的工具：
>
> | 你说 | 工具 | 会发生什么 |
> |---|---|---|
> |「记一下 / 存进知识库」| `save` | 默认进 inbox；可信直写客户端可对明确普通页立即 create/append |
> |「记住我…… / 我的偏好是……」| `remember` | 进入 inbox，并归入 memory 区 |
> |「收藏这家餐厅 / 加进书单」| `collections_upsert` | 进入 inbox，并归为收藏条目 |
> |「加个待办 / 这周还剩什么？」| `todo_add` / `todo_list` | 添加或列出待办 |
> |「查我存过的 X / 关于 Y 我知道什么？」| `search` / `recall` | `recall` 给出带引用的回答和信息缺口提示 |
> |「有哪些事情等我裁定？」| `inbox_list` / `inbox_resolve` | 在主频道浮出案例；你的裁定会自动成为判例 |
> |「审核并晋升这个暂存 Skill」| `skill_inspect` / `promote_skill` / `inbox_resolve` | 批准绑定完整 staging 目录版本，再原子化晋升；普通 `save` 不能新建正式 Skill |

By default, writes enter the isolated inbox and **accepted does not mean filed**. In light-governance mode, only a response explicitly saying “trusted direct write completed” means the ordinary page is already filed; risky operations keep their governed workflows.

> 默认写入先进入隔离 inbox，**已受理不等于已入库**。轻治理模式下，只有响应明确写“已可信直写”才表示普通页已经入库；高风险操作仍走受治理流程。

## Status · 状态

Personal alpha, used daily by the author as tenant #1. Every milestone is running on real hardware: **M0–M3** (read-only MCP + zone ACL + bearer authentication + audit → write path + keeper gate → capture endpoint + iOS app); **M4.0–M4.9** (dashboard + precedent exam / read-side intelligence / lossless tiers / primary-channel agent / provenance + schema evolution + approval night shift / injection resistance / self-service enrollment / digest delivery to persistent hosts). See **[docs/03 §8/§9](docs/03-next-version-spec.md)** for milestones and decision records.

> 个人 alpha，作者本人作为租户 #1 日常使用。所有里程碑都已在真实设备上运行：**M0–M3**（只读 MCP + zone ACL + bearer 认证 + 审计 → 写路径 + keeper 守门 → capture 端点 + iOS app）；**M4.0–M4.9**（仪表盘 + 判例考卷 / 读侧智能 / lossless 分层 / 主频道 agent / 溯源 + schema 演化 + 审批夜班 / 抗注入 / self-service 接入 / 向常驻宿主下发 digest）。里程碑和决策记录详见 **[docs/03 §8/§9](docs/03-next-version-spec.md)**。

## Docs · 文档

- **[docs/05 — Governed Agent Memory](docs/05-pattern-gam.md)** — a standalone, public explanation of the pattern.
- **[docs/07 — Light governance](docs/07-light-governance.md)** — opt-in trusted direct writes for a personal instance with a few trusted agents.
- **[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md)** — an installation protocol to hand to an agent so it can set up the service for you.
- **[run-local.md](run-local.md)** — try it on one local machine without the cloud.
- **[docs/README.md](docs/README.md)** — overview of the design and milestones (02 productization / 03 next-version spec / 05 pattern).
- Storage engine (open source, separate repository): [substrate](https://github.com/wheam/substrate).

> - **[docs/05 — Governed Agent Memory 模式说明](docs/05-pattern-gam.md)**——可以独立发布、面向外部读者的模式说明。
> - **[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md)**——交给 agent 的安装协议，它可以据此替你搭好服务。
> - **[run-local.md](run-local.md)**——不用云，在一台本地机器上试用。
> - **[docs/README.md](docs/README.md)**——设计方案和里程碑总览（02 产品化 / 03 下一版 spec / 05 模式说明）。
> - 存储引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)。

## Contributing · 参与开发

- **Write service code:** see **[CONTRIBUTING.md](CONTRIBUTING.md)** for hard boundaries, contract-first development, precedent exams, and adversarial cross-source review.
- **Run the tests:** `cd service && npm test` (the offline suite has no external dependencies and includes precedent regression exams).

> - **给服务写代码：**参见 **[CONTRIBUTING.md](CONTRIBUTING.md)**，其中说明了红线、契约先行、判例考卷和异源对抗 review 惯例。
> - **运行测试：**`cd service && npm test`（离线测试不依赖外部服务，其中包含判例回归考卷）。

## Repo layout · 目录

```
INSTALL_FOR_AGENTS.md     installation protocol for agents
run-local.md              local, no-cloud walkthrough
CONTRIBUTING.md           development rules, contracts, exams, and adversarial review
railway.json              Railway contract: Dockerfile build, /healthz, restart policy
docker-compose.local.yml  one-command local setup (about 60 seconds)
docs/                     design docs: 02 productization, 03 spec, 05 public pattern
service/                  MCP server: Node 22 + official SDK; tests and Railway image
app/                      experimental iOS capture app and share extension
```

> ```text
> INSTALL_FOR_AGENTS.md     给 agent 的安装协议
> run-local.md              本地单机、无云部署走查
> CONTRIBUTING.md           开发规则、契约、判例考卷和异源对抗 review
> railway.json              Railway 契约：Dockerfile 构建、/healthz 和重启策略
> docker-compose.local.yml  一条命令启动本地服务（约 60 秒）
> docs/                     设计文档：02 产品化、03 spec、05 对外模式说明
> service/                  MCP server：Node 22 + 官方 SDK、测试和 Railway 镜像
> app/                      实验性的 iOS capture app 和分享扩展
> ```

## License

MIT — see [LICENSE](LICENSE).

> MIT——参见 [LICENSE](LICENSE)。
