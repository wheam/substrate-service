# 本地单机试用（无云，就这台机器）

把整套 substrate 服务跑在**一台常开机器上**：keeper 本地跑、数据落本地 git。适合「就我自己 / 一台小服务器」先摸清它是什么，再决定要不要上云。

> **诚实标注 —— 跨不了设备。** 本地形态里知识库只活在**这台机器 + 它的 git 远端**。手机捕获、远程 fleet（多台 CC / Hermes）要「够得着」，需要**云形态**（见 [README 顶部的 Deploy on Railway](README.md) / [INSTALL_FOR_AGENTS.md §4](INSTALL_FOR_AGENTS.md)）。本地形态的定位是「约 60 秒跑起来、看懂它怎么工作」的入门与单机自用（跑起来就是完整服务，没有时限），只是不是跨设备的终态。
>
> **keeper 需要 DEEPSEEK key。** 不填 `DEEPSEEK_API_KEY` 也能起——但会**只读降级**：读工具（search / read_page / …）照常，写入（save / todo_add / …）会停在 `inbox/` 隔离区不前进（keeper 不归档、`recall` 工具不注册）。想看到「keeper 自动归档」，填一把 DeepSeek key 再起。

两条本地路径，任选其一：

- **A. 直接 `node`（最简，无需 Docker）** —— 已逐条实测跑通，见下。
- **B. `docker compose`（要 Docker）** —— 用 [`docker-compose.local.yml`](docker-compose.local.yml)。

服务对实例的**全部依赖**（哪些文件必须在）见 [INSTALL_FOR_AGENTS.md 的「实例契约」表](INSTALL_FOR_AGENTS.md)，此处不重复。

---

## A. 直接 `node`（无 Docker）

**前置**：`node`（22+）、`git`。可选 `DEEPSEEK_API_KEY`。

### 1) 拿服务代码

```sh
git clone https://github.com/wheam/substrate-service.git
cd substrate-service/service
npm ci
```

### 2) 起一个本地实例 + 本地「远端」

服务不直接读一个目录，它 **clone `REPO_URL`** 到 `DATA_DIR/instance`、并周期 `git pull`、写入后 `git push` 回去。本地试用就用一个**本地 bare repo** 当这个远端（真 · 无云）。

先按 [INSTALL_FOR_AGENTS.md 附录 A](INSTALL_FOR_AGENTS.md) 建一个最小实例目录（`governance/zones.md` + `todo/owner.md` + `knowledge/` + `collections/restaurants/data.csv` + `memory/about-owner/` + `inbox/.gitkeep` + 三个 `skills/*.py`），或直接用你已有的 substrate 实例。然后：

```sh
cd <你的实例目录>
git init -b main && git add -A && git commit -m seed
cd ..
git clone --bare <你的实例目录> instance-origin.git   # 这就是本地「远端」
```

记下 `instance-origin.git` 的**绝对路径**，`REPO_URL` 用 `file://` 指它。

> 想真正同步下机（备份 / 换机）？把 `REPO_URL` 换成一个 **GitHub 私有 repo 的 URL**（`https://x-access-token:<PAT>@github.com/<owner>/<repo>.git`）即可，其余不变——那就介于「纯本地」和「上云」之间。

### 3) 生成一把 token

```sh
openssl rand -hex 24
```

### 4) 启动

回到 `service/` 目录（上面 `npm ci` 那处），一行起：

```sh
DATA_DIR=./data \
REPO_URL="file:///绝对路径/instance-origin.git" \
TOKENS_JSON='{"<第3步的token>":{"client":"cc-local","trust":"high","channel":"primary"}}' \
PORT=3000 \
node src/server.js
# 可选：在上面任意行加 DEEPSEEK_API_KEY=sk-... 让 keeper 归档 + recall 上线
```

起来会打印：`instance cloned → …/data/instance`、`recall index ready → …`、`keeper enabled`（填了 key）或 `keeper disabled（缺 DEEPSEEK_API_KEY）`、`substrate-kb listening on :3000`。

### 5) 自验（跑通判据）

```sh
# ① healthz 200
curl -s localhost:3000/healthz          # → {"ok":true,"startedAt":...,"lastPull":{"ok":true,...}}
```

② **search 有结果 / ③ save 落 inbox** 走 MCP（服务只在 `/mcp` 上提供工具）。用你的 agent 接上：

```sh
claude mcp add --transport http substrate-kb http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <第3步的token>"
```

然后在对话里让它 `search`（查一个你实例里有的词，应返回「路径 + 行号 + 片段」）、`save` 一条测试内容（应回「✅ 已受理 → inbox/… 状态 pending」，对应文件真的出现在 `./data/instance/inbox/` 下）。

> 这三条（healthz 200 / search 有结果 / save 落 inbox）本机以「无 DEEPSEEK key = 只读降级」形态**实测跑通**：healthz `ok:true`、search 命中、save 落 `inbox/_YYYY-MM-DD-<id>.md`（status `pending`，等有 key 的 keeper 归档）。

---

## B. `docker compose`（要 Docker）

用仓库根的 [`docker-compose.local.yml`](docker-compose.local.yml)。它把 `./service` 当 build context（Dockerfile 在 `service/`）、`./data` 当 `/data` 卷、`./instance-origin.git` 挂进容器当 `REPO_URL`。

```sh
# 1) 本地 bare repo（同 A 的第 2 步，放在仓库根，命名 instance-origin.git）
#    git clone --bare <你的实例目录> instance-origin.git
# 2) 生成 token（openssl rand -hex 24），填进 docker-compose.local.yml 的 TOKENS_JSON <token>
# 3) 起
docker compose -f docker-compose.local.yml up --build
# 4) 自验：同 A 的第 5 步（curl localhost:3000/healthz，再接 MCP 客户端跑 search / save）
```

DeepSeek key、审计落文件等可选项，在 `docker-compose.local.yml` 里有注释开关。

> 说明：Docker 路径的 compose 挂载 / 环境变量已对着 `service/src/server.js` 入口与 `service/Dockerfile` **逐行静态核对**一致（`context: ./service`、`/data` 卷、`REPO_URL`/`TOKENS_JSON`/`DATA_DIR`/`PORT` 命名与代码一致）；无 Docker 的路径 A 是端到端实测跑通的那条。
