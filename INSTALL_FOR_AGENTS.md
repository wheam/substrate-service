# INSTALL_FOR_AGENTS — 把 substrate 知识库服务搭起来（写给 agent 的安装协议）

> 这是一段交给「你已有的 agent」（Claude Code / Codex / Hermes 等）读的安装协议。
> 主人把这份文件甩给你，你按它把主人的个人知识库（substrate 实例）服务化跑起来。
> 全文以第二人称对**你（安装 agent）**说话。中文为主，命令/代码原样照抄。

---

## 0. 硬规矩（先读，任何一步之前都成立）

1. **密钥只能主人自己填。** API key、PAT、deploy key、token 这类机密，一律由**主人本人**粘贴进平台面板 / 环境变量，或主人亲手交给你直接写进 Railway 变量——你**不复述明文、不写进任何会被提交/上传/落盘的文件**（含本仓库、日志、聊天记录）。需要机密时，你的动作是「停下来，告诉主人去哪个面板填什么」，不是替他生成或保管。
2. **每一步外部操作先列清单、要授权。** 凡是建仓库、开云服务、产生费用、写入主人账户的动作（`railway init`、`railway up`、建 volume、`git push`、`claude mcp add`……），**先把这一批要做什么、会花什么钱、会改什么，列给主人，等他明确说「可以」再做**。不要一路自作主张跑到底。
3. **装完必跑自验清单**（§7），把每条的实际输出贴给主人看。没跑完自验，不许对主人说「装好了」。
4. **诚实标注门槛。** 这套东西有一个要自托管的 MCP server，确有部署门槛。你的职责是把门槛尽量吞进你的自动化里（你去跑 CLI），而不是甩给主人一张 20 步清单。但凡你自己也不确定的步骤，直说，不要糊弄。

---

## 1. 你的角色

你 = 替主人把 substrate 服务搭起来、并接进主人日常对话的那个 agent。终态是：

- 云上跑着一个 `substrate-service`（MCP server + keeper 守门 agent + 捕获端点），它持有并唯一维护主人的知识库实例（一个私有 GitHub repo，markdown + git）。
- 主人日常在用的那个 agent（大概率就是你）接上这个服务的 MCP，成为**主频道**——keeper 拿不准的待裁件会在你和主人的对话里主动浮出，主人一句话你就回传裁定。
- 其它 agent / 手机捕获端点照常读写，但不承担裁决面。

先在 §2 跟主人定路径（云 / 本地单机）。**走云**时，你要做的事按顺序：**看前置（§2）→ 准备实例仓库（§3）→ 部署到 Railway（§4）→ 配 TOKENS_JSON（§5）→ 接客户端（§6）→ 跑自验（§7）**。**走本地单机**时改看 [`run-local.md`](run-local.md)（实例契约 §3、TOKENS_JSON §5、自验 §7 仍适用，只是把「部署到 Railway」换成本地起进程）。

---

## 2. 形态与前置

**两条路径：云为主 + 本地单机试用。** 先问主人一句「**就这台机器，还是所有设备 + 手机？**」来分流：

- **所有设备 + 手机 → 云（完整形态，本节以下 §3–§7 就是它）。** 主人自己维持云（Railway 已是够得着手机 + 远程 fleet 且不架隧道的形态）。这是终态、也是本 INSTALL 的主线。
- **就这台机器 / 先试试 → 本地单机（60 秒试用，无云）。** 服务跑在一台常开机器上、数据落本地 git，`node` 或 `docker compose` 一条命令起。**走查见仓库根的 [`run-local.md`](run-local.md)**（命令已实测跑通），此处不重复。**诚实标注：本地形态跨不了设备**——手机捕获、远程 fleet 要「够得着」仍需上云。keeper 缺 DeepSeek key 时同样只读降级。

下面 §3 起是**云路径**的完整协议。

**主人需要有（缺的先让主人去开）：**

- **GitHub 账号**——放知识库实例（私有 repo）。
- **Railway 账号**——跑服务，约 **$5/月**起。**这是会花钱的**，开服务前按硬规矩 2 跟主人确认。
- **DeepSeek API key（可选但强烈建议）**——keeper 归档判断 + recall 问答都用它。**缺了会降级**：keeper 不归档、`recall` 工具不注册，服务变**只读可用**（读工具照常，写入停在 inbox 不前进）。
- **飞书自定义机器人 webhook（可选）**——哑兜底通知（单向播报）。缺了通知只落服务日志。

**你（安装 agent）手里要有的工具：**

- `git`。
- **Railway CLI**：`npm i -g @railway/cli`（或 `brew install railway`），然后 `railway login`（这一步会开浏览器让主人授权，属于外部操作，先告诉主人）。

---

## 3. 实例仓库（知识库本体）

服务操作的「实例」是一个**私有 GitHub repo**（markdown + git + governance）。两种情况：

- **主人已有 substrate 实例**（如 `redacted-instance`）→ 直接用它，记下它的 git URL 作 `REPO_URL`。
- **没有** → 按**附录 A** 起一个最小实例（能跑通全链的最小形状）。它日后可以整体换成 [substrate 引擎](https://github.com/wheam/substrate)的完整 vendored 版，不用推翻重来。

### 实例契约（服务对实例的**全部**依赖，逐行来自代码）

服务不假设实例里有别的东西，只依赖下面这些。缺哪行，坏对应那一格的功能：

| 路径 | 谁在用它 / 用途 | 缺失时 |
|---|---|---|
| `governance/zones.md`（顶部的 yaml 代码块） | `acl.js` 解析出 zone 注册表（`id` / `path` / `privacy` 等）；所有读工具的 ACL + keeper 的 zone 校验都读它 | **服务基本起不来**：读工具与 keeper 一读 zones 就抛「找不到 yaml 块」 |
| `skills/substrate-runtime-context/render-context.py` | `get_context` 工具用 `python3` 跑它、拿 **stdout 纯文本**当常驻小抄 | `get_context` 报错（`render-context 失败`），其余工具照常 |
| `skills/substrate-curator/curate.py` | keeper 落新页后 reindex、删页时执行（CLI：`reindex --instance . --dir <zone> --apply` / `rm --instance . --page <相对路径> --apply`，cwd = 实例根） | keeper 的 `new_page` / `remove` 归档报错 |
| `skills/substrate-collections/collections.py` | keeper 往收藏表 upsert 行（CLI：`upsert --csv <相对路径> --apply --field k=v …`，argparse flag 顺序无关） | keeper 的收藏类归档报错 |
| `todo/owner.md`（含 `## 待办` 小节） | `todo_list`（不传参 = 读它）+ keeper 的 `todo_add` / `todo_done` | todo 相关工具报错 |
| `collections/<名>/data.csv` | `collections_search` 读 + keeper `upsert_row` 前会校验该文件存在 | 对应收藏的查/写报错 |
| `inbox/` | 一切写入先落这里；`inbox.js` 首次写入时自动 `mkdir -p`，`listEntries` 也容忍它不存在 | 运行期不报错（自动建）；建议放一个 `inbox/.gitkeep` 让 git 从 clone 起就带着这个目录 |
| `knowledge/`、`memory/about-owner/` 等**已在 zones.md 注册的 zone 落点** | 各 zone 的读写落点，须与 zones.md 里的 `path` 一致 | 该 zone 的读/写/归档报错 |

> `memory/about-owner/` 在 zones.md 里标 `privacy: sensitive`——只有 `trust: high` 客户端能读；`get_context` 内嵌了它，所以 `get_context` 也是 high-only。
>
> 注意：`CONSTITUTION.md`（附录 A 里给了）是 substrate 的**治理约定**（给主人 / keeper 看的规矩，也是「新增 zone」流程的落点），服务代码本身不读它——所以它没进上面这张「代码依赖」表，但一个像样的实例应该有它。

---

## 4. 部署到 Railway（你来执行）

> ⚠️ **本仓库的 Dockerfile 在 `service/` 子目录里，不在仓库根**（`service/Dockerfile`）。它的 `COPY package.json src docker-entrypoint.sh` 全是相对 `service/` 的路径，入口是 `docker-entrypoint.sh → node src/server.js`。所以 **build context 必须是 `service/`**——在 Railway 里把服务的 **Root Directory 设成 `service`**，否则 Railway 在仓库根找不到 Dockerfile、或 `COPY` 路径对不上，build 会失败。基础镜像已装 `git` / `python3` / `openssh-client`，所以实例的 `.py` 脚本在容器里能跑、私库能拉。

按硬规矩 2，下面每一步开跑前先跟主人对一遍。顺序：

1. **拿到服务代码**：fork 或 clone 本仓库（`substrate-service`）到主人的 GitHub。
2. **建项目**：在仓库目录里 `railway init`（起一个 Railway 项目/服务）。
3. **把 Root Directory 指到 `service`**：Railway 面板 → 该服务 Settings → **Root Directory = `service`**（或等效的项目配置）。这一步是上面那条警告的落地，别漏。
4. **挂持久卷**：加一个 volume，**mount path 设为 `/data`**（= `DATA_DIR` 默认值，实例会 clone 到 `/data/instance`）。用 `railway volume add`（先 `railway volume --help` 看你这版 CLI 的确切子命令）或在面板 Volumes 里加。
5. **设环境变量**（下面**全表**，逐个设）：用 `railway variables --set "KEY=VALUE"`（先 `railway variables --help` 对一下你这版 CLI 的写法）。**机密（`REPO_URL` 里的 PAT、`DEEPSEEK_API_KEY`、`GIT_SSH_KEY_B64`）按硬规矩 1 由主人填**。
6. **部署**：`railway up`（会用 `service/Dockerfile` build 并跑起来）。
7. **拿域名**：`railway domain` 生成公网域名，记为 `https://<domain>`——后面接客户端要用。

### 环境变量全表

以 `service/src/server.js` 入口块为准（16 个）。**必填只有 `REPO_URL` 和 `TOKENS_JSON`**，其余都有安全默认。

| 变量 | 必填 | 默认 | 说明 / 示例 |
|---|---|---|---|
| `REPO_URL` | ✅ | — | 实例私有 repo 的 git URL。两种鉴权二选一：① **https + fine-grained PAT**，如 `https://x-access-token:<PAT>@github.com/<owner>/<repo>.git`；② **SSH deploy key**，URL 用 `git@github.com:<owner>/<repo>.git` 并配下面的 `GIT_SSH_KEY_B64`。**PAT 最小权限 = 该实例 repo 的 `Contents: Read and write`**（keeper 要 push 归档结果，只读不够）。 |
| `TOKENS_JSON` | ✅ | — | 客户端 token 表（JSON，见 §5）。 |
| `DATA_DIR` | | `/data` | 持久卷挂载点；实例 clone 到 `DATA_DIR/instance`。要和第 4 步挂的 volume mount path 一致。 |
| `PORT` | | `3000` | 监听端口。Railway 会自动注入它自己的 `PORT`，服务读取即可，一般不用手设。 |
| `DEEPSEEK_API_KEY` | | —（缺=降级） | keeper 与 `recall` 的 LLM key。缺 → keeper 不归档、`recall` 不注册，服务变**只读可用**。 |
| `DEEPSEEK_MODEL` | | `deepseek-v4-flash` | keeper/recall 主判模型。 |
| `DEEPSEEK_ESCALATION_MODEL` | | `deepseek-v4-pro` | keeper 拿不准时升档用的模型。 |
| `PULL_INTERVAL_MS` | | `300000`（5 分钟） | 服务端 `git pull` 跟随 GitHub 的间隔。 |
| `KEEPER_INTERVAL_MS` | | `60000`（60 秒） | keeper 扫 inbox 的轮询间隔。 |
| `KEEPER_MIN_CONFIDENCE` | | `0.75` | keeper 自动归档的置信阈值；低于此则转 `held` 待主人裁定。 |
| `KEEPER_NOTIFY_LEVEL` | | `all` | 通知档：`all` 全播报；`quiet` 静音「✅ 已存」成功播报（doctor 报错仍必达）。 |
| `NUDGE_TTL_MS` | | `14400000`（4 小时） | 主频道待裁提示的防重复 TTL：同一批 `held` 件在此窗口内，工具响应尾部只提醒一次。 |
| `NIGHTLY_INTERVAL_MS` | | `604800000`（7 天） | 夜班养护（去重/合并薄页/断链）确定性扫描间隔，产出走 inbox 的预批提案；`0`=禁用。仅在 provider 在场（`DEEPSEEK_API_KEY` 有值）时才挂。 |
| `FEISHU_WEBHOOK_URL` | | —（缺=只打日志） | 飞书自定义机器人 webhook，哑兜底通知。缺 → 通知只落服务日志。 |
| `FEISHU_WEBHOOK_SECRET` | | — | 飞书 webhook 加签密钥（机器人开了「签名校验」才需要）。 |
| `AUDIT_FILE` | | —（缺=只进 stdout） | 审计另存到卷上文件的路径。缺 → 审计只进 stdout（即 Railway 日志）。 |

**进阶 / 可选**（不在入口块里，但代码真实生效，按需用）：

- `GIT_SSH_KEY_B64`——SSH deploy key（ed25519 **私钥**的 base64）。用 SSH 拉私库时配；`docker-entrypoint.sh` 会把它落到 `/root/.ssh/id_ed25519` 并钉死 GitHub 官方 host key。与「`REPO_URL` 用 https + PAT」二选一。**机密，由主人填。**
- `INDEX_PATH`——`recall` 检索索引文件路径；默认落在 `DATA_DIR`（实例目录之外）。**红线：索引不得落在实例 git 工作树内**（否则 `git clone` 带走会有损）。索引可删可重建，一般不用动。

---

## 5. TOKENS_JSON —— 每客户端一把 token

`TOKENS_JSON` 是一个 JSON 对象：**key = token 字符串，value = 该客户端的元信息**。每个客户端（每台 CC、每个 Hermes、手机 App）**各发一把独立 token**，可单独吊销、全量审计。

- **生成 token**：一把用 `openssl rand -hex 24`。**生成与填入由主人做**（硬规矩 1）。
- **字段**：
  - `client`（必填）：这把 token 属于谁的可读名字，如 `cc-mbp`、`hermes-railway`、`app-ios`（进审计日志）。
  - `trust`（必填）：信任级——
    - `high`：读写全量，含 `sensitive` 敏感区（`memory`）、`get_context`、`/digest`，以及全部写工具。
    - `capture`：**只能投 `/capture`** 端点（手机捕获）；打 `/mcp` 直接 403，`/digest` 也拿不到。
    - 其它任意值（如 `low`）= **低信任只读**：只读非敏感 zone，没有写工具、没有 `get_context`、没有 `/digest`。
  - `channel`（可选）：**主频道那把**加 `"channel": "primary"`——就是主人日常对话在用的那个 agent。**只在 `trust: high` 时生效**（主频道房规/浮出依赖 inbox 工具，而 inbox 是 high-only）；标了 primary 却不是 high，服务启动会 `console.warn` 点名告警、该标记不生效。可以给多把标 primary（都会收到浮出提示）。

**示例**（把 `<...>` 换成 `openssl rand -hex 24` 生成的真值；这段最终会成为 `TOKENS_JSON` 的值）：

```json
{
  "<cc-mbp-token>":       { "client": "cc-mbp", "trust": "high", "channel": "primary" },
  "<hermes-token>":       { "client": "hermes-railway", "trust": "high" },
  "<teammate-token>":     { "client": "teammate-ro", "trust": "low" },
  "<app-token>":          { "client": "app-ios", "trust": "capture" }
}
```

> 设进 Railway 时它是**一个变量的值**（整段 JSON）。因为里面是 token 明文，按硬规矩 1 由主人填进 Railway 变量面板。

---

## 6. 接入客户端

拿 §4 的 `https://<domain>` 和 §5 里对应的 token：

- **主频道 agent（用 primary 那把 high token）**——Claude Code：

  ```
  claude mcp add --transport http substrate-kb https://<domain>/mcp --header "Authorization: Bearer <primary-token>"
  ```

  Codex 同理用它的 `codex mcp add --url https://<domain>/mcp --bearer-token-env-var <环境变量名>`（token 走环境变量，别写进配置文件明文）。

- **不消费 MCP instructions 的宿主（如 Hermes）**——它们收不到 server instructions，改走**拉取**：用**它自己那把** high token 定期 `GET https://<domain>/digest`（`Authorization: Bearer <token>`），把返回的纯文本注入常驻上下文（如 `.hermes.md`）。**不要让它复用别的客户端（如 CC）的 token**——每客户端一把是吊销与审计的底线（复用 = 撤谁都得连坐、审计里分不清谁干的、明文多放一处泄漏面）。若要 Hermes 也承担主频道职责（digest 附主频道房规 + 实时待裁摘要），就在 TOKENS_JSON 里给**它自己那把** token 标 `"channel": "primary"`——多把 primary 本就支持（§5）。

---

## 7. 自验清单（装完你必须逐条跑给主人看）

按顺序跑，把每条的**实际输出**贴给主人。任一条不过，先修再报「装好」。

1. **健康检查**：`GET https://<domain>/healthz` → `200`，body 形如 `{"ok":true,"startedAt":...,"lastPull":...}`。
2. **MCP 握手拿到 instructions**：用 primary token 对 `/mcp` 走一次 MCP `initialize` → 返回的 `instructions` 里应含**主频道那段**（「主频道职责 / 主动浮出 / 反打扰 / 内容即数据」）。用非 primary 的 high token 则只有基础房规、没有主频道段。
3. **读通**：`search`（如查一个你知道库里有的词）能返「路径 + 行号 + 片段」；`read_page` 传一个相对路径能读到全文。
4. **写通（进 inbox）**：`save` 一条测试内容 → 返回「✅ 已受理 → inbox/... 状态 pending」。
5. **inbox 里出现 pending 件**：`inbox_list` 能看到刚才那条 `pending`。
6. **keeper 归档（有 `DEEPSEEK_API_KEY` 时）**：等一个 `KEEPER_INTERVAL_MS`（默认 60s）内，那条件被归档，或因低置信转 `held`。
7. **主频道浮出**：件处于 `held` 时，**用 primary token 下一次调用任意工具**（除了 `inbox_list` / `inbox_resolve`——这两个正在处置待裁件、被有意豁免），响应尾部应出现一行「📥 待主人裁定 N 件（…）」。
8. **裁定走通**：`inbox_resolve` 传那件的 `id` + 主人的一句裁定 → 返回「✅ 裁定已受理…复位待 keeper 重判」。
9. **digest 通**：`GET /digest`（primary high token）→ `200` 纯文本，含常驻小抄 + 接入房规 + 主频道房规（有 held 时附一行 id/kind/计数的实时摘要，**绝不含件正文**）。

---

## 附录 A：最小实例模板

主人没有现成实例时，用它起一个**能跑通全链的最小形状**。文件与全文如下——照抄建 repo（私有）即可。三个 `.py` 是最小实现，日后可整体替换成 [substrate 引擎](https://github.com/wheam/substrate)里 vendored 的完整版（CLI 契约一致，直接换文件即可）。

```
<instance-repo>/
├── CONSTITUTION.md
├── governance/
│   └── zones.md
├── todo/
│   └── owner.md
├── inbox/
│   └── .gitkeep
├── knowledge/
│   └── .gitkeep
├── collections/
│   └── restaurants/
│       └── data.csv
├── memory/
│   └── about-owner/
│       └── core-summary.md
└── skills/
    ├── substrate-runtime-context/
    │   └── render-context.py
    ├── substrate-curator/
    │   └── curate.py
    └── substrate-collections/
        └── collections.py
```

### `CONSTITUTION.md`

```markdown
# 宪法 — 本知识库的不可违规矩

1. 文件即真相：一切正典是 markdown + git，其余（索引等）都是可重建的派生物。
2. 一切写入先进 `inbox/` 隔离区，由 keeper 审核后才归档；写路径不碰库本体。
3. 骨架区（`governance/`、`skills/`）不经服务删除；删任何页都留 git 历史。
4. 凭据 / 密钥永不落库（命中即真拒，不进任何分层）。
5. 新增 zone 走「提议 → 主人一句话批 → 落地 + doctor 校验」，不静默改结构。
```

### `governance/zones.md`

````markdown
# zones — 分区注册表

```yaml
zones:
  - id: todo
    path: todo/
    purpose: 待办清单
    schema: todo-zone-v1
    maintainer_skill: substrate-todo
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: knowledge
    path: knowledge/
    purpose: 互链知识页
    schema: knowledge-zone-v1
    maintainer_skill: substrate-curator
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: collections
    path: collections/
    purpose: 通用收藏
    schema: collection-zone-v1
    maintainer_skill: substrate-collections
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: memory
    path: memory/about-owner/
    purpose: 跨 agent 共享的「关于主人」记忆
    schema: memory-zone-v1
    maintainer_skill: substrate-memory
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: sensitive
```
````

> 解析器（`acl.js`）只认这个固定形状：一个 yaml 代码块围栏 + `zones:` 列表，列表项 `  - id:`（2 空格缩进），字段 `    key:`（4 空格缩进）。代码强制生效的字段是 `id`、`path`、`privacy`（`sensitive` = 仅 high 可读）；其余字段是给人/引擎看的约定。

### `todo/owner.md`

```markdown
---
title: 待办 — 主人（owner）
type: todo
---

## 进行中

- （示例）修剪花园的柠檬树

## 待办

1. （示例）给自行车换轮胎
```

> 必须有 `## 待办` 小节——keeper 的 `todo_add` 往它下面插条目。

### `inbox/.gitkeep` 与 `knowledge/.gitkeep`

都是空文件。git 不跟踪空目录，所以每个**已注册但暂时没有内容页的 zone 目录**都要放一个 `.gitkeep`，让它 clone 后就存在——否则 keeper 首次往该 zone 落新页时 `writeFileSync` 会因父目录不存在而报错（它不建父目录）。本模板里 `todo/`、`collections/`、`memory/about-owner/` 已有实际文件，只有 `knowledge/` 和流水区 `inbox/` 需要 `.gitkeep`（`inbox/` 服务首次写入时也会自动建，但 clone 起就带着更稳）。

### `collections/restaurants/data.csv`

```csv
id,name,city,cuisine,status,notes
```

> 一个最小收藏表，只要表头这一行。keeper `upsert_row` 会按 `id` 幂等地追加/更新行。

### `memory/about-owner/core-summary.md`

```markdown
---
title: 核心摘要 — 关于主人
type: memory
---

- 主人称呼（示例）Alex。
```

> 这是 `sensitive` 区，只有 high 客户端能读；`render-context.py` / `get_context` 会用到「关于主人」的核心。

### `skills/substrate-runtime-context/render-context.py`

```python
#!/usr/bin/env python3
# 最小实现：把「关于主人」的常驻小抄打到 stdout（纯文本）。
# get_context 工具直接把这段 stdout 当常驻上下文。
# 可整体替换成 substrate 引擎里 vendored 的完整版（按实例内容渲染更丰富的小抄）。
print("# Substrate 常驻上下文")
print("主人称呼（示例）Alex。")
```

### `skills/substrate-curator/curate.py`

```python
#!/usr/bin/env python3
# 最小实现：与 substrate 引擎 curate.py 同 CLI 契约。
#   reindex --instance <根> --dir <zone 目录> --apply  —— 把目录下内容页登记进该目录 README
#   rm      --instance <根> --page <相对路径> --apply  —— 删一页
# keeper 归档新页 / 删页时调用它。可整体替换成引擎的完整版（同 CLI，直接换文件）。
import argparse, pathlib

p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
r = sub.add_parser("reindex")
r.add_argument("--instance", required=True)
r.add_argument("--dir", required=True)
r.add_argument("--apply", action="store_true")
rm = sub.add_parser("rm")
rm.add_argument("--instance", required=True)
rm.add_argument("--page", required=True)
rm.add_argument("--apply", action="store_true")
a = p.parse_args()

if a.cmd == "rm":
    target = pathlib.Path(a.instance) / a.page
    assert target.is_file(), f"not a file: {a.page}"
    if a.apply:
        target.unlink()
    print("removed " + a.page)
    raise SystemExit(0)

d = pathlib.Path(a.instance) / a.dir
readme = d / "README.md"
lines = [
    f"| [[{f.stem}]] | {f.stem} |"
    for f in sorted(d.rglob("*.md"))
    if f.name != "README.md" and not f.name.startswith("_")
]
if a.apply:
    text = readme.read_text() if readme.exists() else f"# {a.dir}\n"
    text += "\n" + "\n".join(lines) + "\n"
    readme.write_text(text)
print("reindexed " + a.dir)
```

### `skills/substrate-collections/collections.py`

```python
#!/usr/bin/env python3
# 最小实现：与 substrate 引擎 collections.py 同 CLI 契约。
#   upsert --csv <相对路径> --apply --field k=v [--field ...]  —— 按 id 幂等追加/更新一行（flag 顺序无关）
# keeper 归档收藏条目时调用它。可整体替换成引擎的完整版（同 CLI，直接换文件）。
import argparse, csv

p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
u = sub.add_parser("upsert")
u.add_argument("--csv", required=True)
u.add_argument("--field", action="append", default=[])
u.add_argument("--apply", action="store_true")
a = p.parse_args()

fields = dict(f.split("=", 1) for f in a.field)
assert "id" in fields, "id required"

with open(a.csv, newline="") as fh:
    reader = csv.reader(fh)
    header = next(reader)
    rows = [dict(zip(header, r)) for r in reader]

hit = [r for r in rows if r.get("id") == fields["id"]]
if hit:
    hit[0].update(fields)
else:
    rows.append({**{c: "" for c in header}, **{k: v for k, v in fields.items() if k in header}})

if a.apply:
    with open(a.csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in header})
print(("APPLIED" if a.apply else "DRY") + " upsert " + fields["id"])
```

---

装完回到 §7，把自验清单逐条跑给主人看。
