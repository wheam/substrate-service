# 03 — 下一版 spec：受治理的 agent 记忆（MCP 版 substrate v0.3，开源参考实现）

> 状态：SPEC / 待动工（2026-07-05）。承接 01 个人 alpha（M0–M3 已完成、已上真机；**含个人实例细节，未随开源仓库发布**）、[02](02-productization.md)（长期产品化——其中托管 SaaS 部分本版**冻结**）。
> 定位一句话：给你一份**所有 AI 共享、且不会随增长而变乱的长期记忆**（受治理、可 `git clone` 带走）；把已跑通的个人 alpha，升级为 **「受治理的 agent 记忆」这个模式的开源参考实现**——我自己是租户 #1，也是模式作者。
> **命名约定**：项目名保持 **`substrate`**（不改）；**模式**对外名暂用 **Governed Agent Memory / 受治理的 agent 记忆（GAM）**（临时，不纠结，见 §9）。
> 依据：2026-07-05 对 gbrain / openhuman 的调研 + fable5 / Codex(GPT-5.5) 两轮外部评审（要点已并入 [02 §9](02-productization.md) 与本 spec 各节），据拥有者定调收敛。

---

## 0. 目标、成功判据与非目标

**目标**
1. 强化四条特色（§1），补齐让它**可信、可被采用**的必要能力。
2. 达成两条硬原则（§2）：**装得极简、用得几乎零负担**。
3. 产出「作者的证据链」：亲身重度使用 + 装了仪表的漏斗数据 + 公开的判例回归 benchmark + 别人一个 prompt 能自托管起来。

**成功判据（可量化；阈值多数待 M4.0 拿到基线后锁定）**
- **漏斗健康**：捕获次数不随时间下滑；**捕获放弃率**（App/端点发起却没进库）不上升；**held 半衰期**（从 held 到被裁定的中位时长）< 24h。
- **检索**：**落空率**（查询返回空 / agent 未采用结果）基线后定阈，且逐版下降。
- **keeper 质量**：**判例回归考卷通过率 ≥ 95%**；换模型 / 改系统提示**必跑**、不达标不上线。
- **安装**：一个没搭过服务的人，「粘 prompt + 回答提问 + 授权」，**≤ 30 分钟**起一个能用的库。
- **主权/离线**：任一时刻 `git clone` 到本地即得完整可读副本（索引不持有任何独有正典，§6.4 铁律）。

**非目标（明确不做，守焦点）**
- 笔记软件 / 编辑器（赛道太挤，竞争不过）。
- 托管 SaaS 的重装机器：账号 / OAuth 正式化 / 多租户 / 计费 / App 上架——**全冻结**（走 OSS 自托管路线绕开「托管陌生人隐私数据」的信任泥潭）。
- 把治理退回客户端 fat skills（违背特色）；读侧智能一律往服务端集中。
- takes-vs-facts 两层存储本体（只留元数据原语，§3.3 / §6.1）。
- 跟 gbrain 拼 DB / 图谱的最大主义（守「文件即真相 + 可抛索引」）。
- 再写战略对比 / 定位演练文档（评审的元警告：别对着 25k star 的对手反复做沙盘）。

## 1. 立身之本：受治理的 agent 记忆（模式命名 + 四特色）

**一段式定义**：隔离 inbox（写路径无 LLM、秒回）+ LLM 只出结构化决定 + 确定性执行器（LLM 从不碰文件）+ 判例法（主人裁定自动立判例）+ 回归考卷 + 文件即真相（markdown+git）+ 服务端集中治理（不靠逐 agent 自律）+ 全程审计。

**四条特色（本版强化对象）**
1. **受治理的写入**（keeper 模式）—— 能让你当「作者」的那个原子。
2. **可带走的真相 / 主权** —— markdown+git 是唯一真相；**主权叙事 = 离线叙事**（`git clone` 即离线可读）。
3. **agent 中立 + 服务端集中治理** —— 任意 MCP agent 连上即得。
4. **可审计** —— 每次读写留痕、每次准入有人话理由。

## 2. 两条硬原则（本版新增，贯穿一切设计）

### 原则 A：装得极简——趋近「一个 prompt 给 agent 就好」
- 理想：把一段 prompt 交给用户已有的 agent（CC / Codex / Hermes），agent 自己读安装协议、把整套搭起来。与 v1 诉求一致。
- 现实约束：我们有个 MCP server，不是人人好部署。策略 = **把门槛塞进 agent 的自动化里，而不是塞给人**。允许 agent 反过来要求「装个 Railway CLI / 填个 key / 授权一下」，但**绝不让人对着 1234 步自己搭**——那非常难用。
- 判据：见 §0 安装判据。

### 原则 B：用得几乎零负担——使用中基本不用管维护、不用思考
- 裁决 / 定夺集中到**一个「主频道 agent」**（§4）：所有需要主人拍板的东西，由它在**你已经在用的对话里**问你，认知触点最少。
- 维护不占用户脑子：夜班养护（去重 / 矛盾 / 断链）自动跑，但**以提案形式**回到同一条裁决通路（§3.5），你只在对话里回一句。（M4.6 修订：能降级为可逆自动动作的，连这一句也省——见下条判据与 §9 M4.6。）
- App 降级（§4）：它多一个要装的东西、多一种认知，与本原则冲突；核心裁决面上移到主频道 agent。
- **判据（M4.6 增补，2026-07-06 主人拍板）**：任何要人操作的面，先过两问——① 这一步**人非做不可吗**？能降级为可逆的自动动作（lossless 系统里删除≈不存在，降级/归档不需要批）就不要问人；② 若必须问人，问的是不是**只有人能判断**的事（个人事实/偏好争议、库结构塑形），且**裁定通道有权兑现**（不给人无权兑现的按钮）？违反任一问 = 设计缺陷，不是可接受的折衷。

## 3. 能力增量（相对现在的 M3）

### 3.1 lossless capture + governed promotion（分层晋升，永不真丢）
- **为什么**：纯「进门先拒」会伤捕获漏斗（两个模型共识）。要让「什么都不丢 + 库干净」同时成立。
- **做什么**：把 inbox 状态机扩成**分层**（落点见 §6.2）——`raw`（inbox 待判）→ `candidate`（keeper 收了但低置信 / reference：可被检索、低权重、带来源）→ `canonical`（高置信或人裁：进主 zone、默认检索）。`held` 保留。**`rejected` 改为「隔离但可检索、带旗标」**，默认检索排除它、但可查得到，不物理删除。
- **边界**：**安全红线不变**——凭据 / 密钥仍「永不落库」（forbidden = 真拒，不进 lossless 层，见 §7）。lossless 只针对「低价值 / 跑题」的合法内容，不针对密钥。

### 3.2 读侧智能：服务端 `recall`/`think` 工具 + 可抛索引
- **为什么**：只有 grep，语义查询第一天就漏（共识：崩点是查询模式不是页数）；OSS 抢 mindshare 需要像样的召回。检索「手艺」应集中在服务端一处（强化特色），**不回退客户端 skill**。
- **做什么**：新增服务端 **`recall`/`think`** 工具（契约见 §6.3）；上一个**可删可重建的索引文件**（SQLite FTS5 + 可选 sqlite-vec 语义，见 §6.4）。默认纯词法，语义作升级档（§9 已定）。
- **边界**：文件仍是唯一真相；索引随时删除重建；一致性由 keeper 单写口天然近乎免费——**curate-at-the-door 与派生索引是协同**。

### 3.3 溯源 + 置信 + epistemic type（写进 frontmatter，不建两层本体）
- **为什么**：多 agent 同时写你的记忆，「谁断言的、基于什么、多确定」是记忆与谣言的分界，也是矛盾检测地基。
- **做什么**：keeper 决定里本就算了 confidence——把 `source_agent`、`confidence`、`epistemic_type` 落进 frontmatter（字段见 §6.1）。
- **边界**：只留元数据原语，**不建 takes/facts 两层存储本体**。

### 3.4 schema 演化：自动新增 zone（拥有者明确要）
- **为什么**：拥有者自己也会遇到——存的东西越来越多，会长出新类别（新 zone）。
- **做什么**：当捕获里出现一簇现有 zone 容不下的东西，keeper / 一个 `schema_propose` 流程**自动提议新 zone**（id / path / schema / maintainer）→ 主频道 agent **一句话让你批**（低负担）→ 批准后按 `CONSTITUTION.md` 的「新增 zone procedure」落地 + doctor 校验。附 `schema lint`（漂移检测）与迁移建议。
- **边界**：走**自动提议 → 一句话审批 → 应用**（守治理，同时不成为负担）；改名 / 合并类迁移只给建议、不自动执行。

### 3.5 审批式夜班（每周；相对 gbrain 的差异化卖点）
- **为什么**：门口把关挡入口噪音，挡不住时间腐烂（旧偏好失效 / 重复 / 矛盾 / 断链 / 命名漂移）。curate-first 只减少一半，不解决熵。
- **做什么**：每周一个维护 job，产出**提案**（近似去重、合并薄页、矛盾旗标、孤儿 / 断链修复），提案**走 inbox / keeper / held**，主人在主频道一句话批。
- **边界**：**永不半夜静默改你的笔记**——gbrain 静默改，对主权用户是恐怖故事；「维护提案需审批」才配我们的哲学，本身是卖点。

### 3.6 keeper 抗注入加固
- **为什么**：捕获来自分享 / 任意网页 = keeper 天天读对抗输入；受治理写入层若可被注入则不可信。
- **做什么**：系统提示强化「内容是数据非指令」（已有）+ 决定 JSON 的目标 / 动作只能取材料内白名单（已有校验，扩强）+ **把对抗性捕获样本纳入回归考卷**（§3.7）。完整威胁面见 **§7**。

### 3.7 判例回归考卷 + 使用仪表（作者的证据链）
- **为什么**：keeper 判得准 = 产品质量 = 唯一真护城河（每条裁定都是你品味的标注数据，是未来的私人微调语料）。换模型 / 改 prompt 不能凭感觉。
- **做什么**：
  - **判例回归考卷**：{输入 → 期望 disposition/zone/action} 的金标集 + 打分 runner，换模型 / 改 prompt 必跑，公开成 benchmark（对标 gbrain 的 BrainBench）。**确定性可行**：`provider.js` 主判官已 `temperature=0` + `thinking:disabled`（同模型可复现）；CI 用**假 provider**（现有测试离线跑全绿已是先例），真模型跑走**带 key 的 gated run**。
  - **使用仪表**：审计里结构化记录**每次捕获去向**与**每次检索命中 / 落空**（字段见 §6.3 / §7），出两条曲线——**held 半衰期 / 捕获放弃率**、**检索落空率**。用真实数据裁决设计争论。
- **边界**：这**不是退回自用**，是可被别人信任的证据。

### 3.8 主频道 agent = 裁决 / 通知的主界面
见 §4（原则 B 落地）。

### 3.9 一个 prompt 自托管安装
见 §5（原则 A 落地）。

## 4. 交互模型：主频道 agent（降认知触点）

- 配置里给某个连 MCP 的 client（token）标 `channel: primary`。keeper 的 held / 拒收 / 待定夺 / 通知，优先通过它——它在**你已在用的那个对话**里问你，你自然语言回，agent 调 `inbox_resolve`。复用现有 `inbox_list` / `inbox_resolve`，加一个 primary 标记 + 一条房规「主频道 agent 应主动浮出待裁件」。
- 其它 agent 照常读写，但不承担裁决面。飞书通知降为哑兜底。
- **App 的处置：降级为「可选 / 待定」**
  - 裁决功能**上移到主频道 agent**（不再需要专门开 App 看）。
  - 分享捕获入口（如刷 Twitter 分享进库）视作**「未来 agent 有没有入口」的问题，不由我们解决**；保留 `/capture` 端点（快捷指令 / webhook 仍可投），但**不把 App 当核心**。
  - 现有 iOS App 保留为实验件，不投入迭代，待观察。
- **落点（M4.3 已实现）**：主动浮出 = primary 客户端工具成功响应**尾部 piggyback**「📥 待主人裁定 N 件」提示（防重复：held id 集合为 key，`NUDGE_TTL_MS`（默认 4h）窗口内只发一次；`inbox_list`/`inbox_resolve` 豁免）+ **per-client MCP instructions**（primary 附主频道房规 `PRIMARY_RULES`）+ **`/digest` primary 版**（房规 + 实时 held 摘要，只带 id/kind/计数）。push/pull 之争的裁决见 §9。

## 5. 安装模型（原则 A 落地）

- **目标形态**：`INSTALL_FOR_AGENTS.md` 式的一段 prompt → 用户已有 agent 读它 → agent 驱动全过程：装 CLI、建服务、要 key、部署、`claude mcp add` 接主频道、跑验证。人只回答问题 + 授权。
- **路径（按简单度，装的人只挑一条）**：
  1. **本地单机**（最简、无云）：服务跑在一台常开机器上，keeper 本地跑、push 到 GitHub。适合「就我自己 / 一台小服务器」；跨不了设备。
  2. **agent 驱动的一键云部署**：agent 跑 Railway CLI 建 service + volume、设 env、部署；给 Railway button 兜底。**完整形态**（够得着手机 + 远程 fleet）。
  3. 高级手动（文档留档，不主推）。
- **关键**：把「人要理解的步骤」压到最少，编排交给 agent；诚实标注 MCP server 自托管确有门槛，我们的工作就是把门槛尽量吞进自动化。

## 6. 数据模型与契约

> 把 §3 的能力落成可直接实现的契约。原则：**要紧信息一律在 markdown frontmatter 里**（文件即真相），索引只是派生。

### 6.1 页 / 条目 frontmatter 新增字段
| 字段 | 取值 | 语义 | 默认 / 迁移 |
|---|---|---|---|
| `content_id` | 稳定短 id（如 8 位 hash） | 页 / 条目的稳定标识，扛改名；索引与链接引用它 | 现有页一次性 backfill 生成 |
| `tier` | `canonical` / `candidate` / `rejected` | 分层晋升（§3.1）；默认检索只看 `canonical` | 现有页默认 `canonical` |
| `source_agent` | client 名（如 cc-mbp） | 谁写的 / 谁提议的 | 现有页留空 |
| `confidence` | 0.0–1.0 | keeper 判断置信（本就有） | 落盘即写 |
| `epistemic_type` | `fact`/`preference`/`decision`/`opinion`/`excerpt`/`to-verify` | 记忆条目的认知类型（防污染） | 现有页留空，可后续回填 |

- **不建两层本体**：以上全是普通 frontmatter 元数据，doctor 需对未知键宽容（**引擎零改动前提，须先验证**；沿用现有 `_` 前缀结构页豁免机制）。

### 6.2 inbox 状态机（扩展）
- 现状：`pending → filed / rejected / held`。
- 新增：`filed` 细分为落 `tier: candidate` 或 `tier: canonical`；`rejected` 不再删件，改为**隔离可检索 + 旗标**（`tier: rejected`）。
- **红线不变**：命中凭据 / 密钥 = `forbidden` **真拒、不落盘**（不进 lossless 分层），见 §7。

### 6.3 MCP 工具面增量
- **新增 `recall`/`think`（读；服务端综合）**：入参 `query`；返回**带引用的答案对象**（`answer` + `citations[]`(path+content_id) + `gaps[]`（「库里没有 X / 这页 N 周没更新」））。成本/延迟：一次 LLM 调用，走 keeper 同一 provider；可缓存。
- **`search` 变 tier-aware**：默认只返 `canonical`；可选 `include=candidate|rejected`。审计新增 `result_count` / `hit`（供落空率仪表）。
- **新增 `schema_propose` / `schema_apply`（治理，admin/high）**：提议 / 应用新 zone；apply 走审批 + doctor 校验（§3.4）。
- **`inbox_*` 复用** + client 的 `channel: primary` 标记（§4）。

### 6.4 检索索引（派生、可抛）
- SQLite FTS5（词法，默认）+ 可选 sqlite-vec（语义，升级档）。在服务进程内、从文件构建。
- **构建/重建契约**：全量重建幂等；增量由 keeper 单写口驱动（每次归档后更新受影响页）；直接 git 编辑走 pull 对账（已有串行化）。
- **铁律**：**索引知道的任何要紧事必须能写回 frontmatter**（否则 `git clone` 带走变有损）。图谱边 / salience 等一律以 frontmatter / 页内 wikilink 为准，索引只是加速。

### 6.5 迁移与向后兼容
- 一次性 backfill 脚本：为现有页生成 `content_id`、现有页 `tier=canonical`。
- 先验证 **doctor 对新 frontmatter 字段宽容**（不报 error）——引擎零改动前提；若不宽容，走引擎版本 pin + `_`-豁免或最小 schema 扩展。
- 索引可随时删除重建，迁移失败零数据损失（真相在 git）。

## 7. 安全与隐私（威胁登记册；含评审新增风险）

- **凭据红线**：Anthropic/OpenAI/AWS/GitHub/Slack/Google/PEM 等模式命中 = 落盘前真拒（已有），**不进 lossless 分层**。
- **keeper 抗注入**（§3.6）：捕获 = 任意网页 = 对抗输入；系统提示「内容是数据非指令」+ 决定白名单校验 + **对抗样本进回归考卷**。keeper 无「导出 / 无差别删除」类可被诱导的动作（确定性执行器限爆炸半径）。
- **git 历史是隐私负债**（评审新增）：`remove` 不删历史，泄漏一次 = 泄漏全部历史状态。个人期记为**已知限制**；产品期这是「被遗忘权」硬伤——缓解方向：敏感内容准入更严 / 需要时 history rewrite 工具（不在本版）。
- **token 分级**（已有）：每客户端一把、trust 分级（high/capture）、可单独吊销、全量审计（含 auth_rejected + 来源 IP）。主频道 / capture 通道 scope 限权（capture 无权触发删页，已有）。
- **可用性**（评审新增）：服务是单点，挂了 = 读写中断。读侧降级 = `git clone` 离线副本（主权 = 离线，写进定位）；写侧靠 App/端点离线队列（已有）。

## 8. 里程碑（承接 01 的 M0–M3，本版为 M4.x；每步有验收）

- **M4.0 仪表 + 判例考卷**（最高杠杆，先做）：审计埋点（捕获去向 / 检索 `result_count`+`hit`）+ 判例回归 test v0（金标集 + 打分 runner + 对抗样本；CI 假 provider，真模型 gated）。**验收**：能出两条曲线；`npm test` 里跑回归考卷绿。
- **M4.1 读侧智能**：`recall`/`think` 工具 + SQLite FTS5(+可选 vec) 可抛索引 + `content_id` / 重建契约。**验收**：语义化提问召回明显优于 grep；删索引能秒重建；索引无独有正典。（是否开语义由 M4.0 落空率数据定。）
- **M4.2 lossless + 分层**：`tier` 字段贯穿写入 / 检索；`rejected` 隔离可查；检索默认只看 `canonical`。**验收**：低价值件不丢仍可查、默认检索不含它；密钥仍真拒。
- **M4.3 主频道 agent + 装 prompt**：`channel: primary` 标记 + 房规 + INSTALL_FOR_AGENTS 式安装协议。**验收**：一个新用户一段 prompt 起库；held 件在主频道被主动浮出并可对话裁定。
- **M4.4 溯源 / 置信 frontmatter + schema 演化提议 + 审批式夜班**。**验收**：新 zone 能被提议 → 一句话批 → 落地且 doctor 0 error；夜班提案走 inbox。✅ **已完成**（编排验证：244 测试绿 + 考卷 25/25 + 端到端烟雾 18/18 + Codex xhigh 四轮对抗 review 收敛至 merge-ready；决策见 §9）。
- **M4.5 抗注入 + 开源打包**：对抗样本进考卷、Railway 部署路径、本地单机入口、干净 README / 安装文档、模式 spec 对外版。✅ **已完成**（编排验证：250 测试绿 + 考卷 45/45 + Codex xhigh 全批 + 两轮聚焦复核 merge-ready；对抗金标 25→45、adversarial 5→19；凭据红线四层加固 raw→白空格→`\p{Cf}`→`\p{Mn}/\p{Me}/\p{Cc}`（堵空白/换行/零宽/组合标记隐形拆分）；考卷 confidence 越权假绿修复；决策见 §9）。
- **M4.6 夜班去人化 + 裁定面按通道收窄**（2026-07-06 立项，源于夜班首跑真机复盘——主人被要求裁「做不了判断」的删页提案、且 App 裁定被通道限权正确拒绝后弹回，违反原则 B）：夜班对薄页/重复页从 `remove_page` 提案改为**非破坏性降级**（新 executor action `set_tier`，确定性执行、零裁定、进程内直执行不经 inbox 往返）；held 件带「可裁通道」属性，capture 通道只见它有权兑现的件（maintenance/schema 对 App 只读）；断链等报告类产物落维护日志页 + agent digest，不进主人收件箱。**验收**：夜班整轮跑完主人零操作；App 待定夺列表不再出现 maintenance 件；降级动作审计可查、高信任通道一句话可撤（re-promote）；现存遗留（3 件弹回删页提案 + 1 件断链报告）收编清零；凭据红线 + 进程内批准登记表回归考卷全绿。设计裁定见 §9。✅ **已完成并上真机**（2026-07-06 railway up 部署验证：migrateLegacy 真机关闭 3 件弹回删页提案、断链报告转维护日志、后续 tick 幂等归零、**审计零 demote 事件 = 「迁移只关件、绝不碰内容页」blocker 修复真机确认**；Codex 异源两轮对抗收敛〔真 blocker：迁移信 git-pull 伪造件正文可软删敏感正典页 → 砍成只按 client+kind 行政字段关件〕；283 测试绿 + 考卷 45/45。2026-07-10 复核：生产 `inbox_list` 返回空 = 遗留清零维持。打勾系 2026-07-10 补记，完成即 07-06。）
- **M4.7 collections_search 读侧修缮**（2026-07-06 立项，源于 Hermes 真机截断事故——查餐厅库一把全拉、MCP 返回过大被截断、退化成逐条核对小查询）：`collectionsSearch` 加分页（limit/offset）、列投影（columns）、按列过滤（where）、响应字节预算、`truncated` 契约（返回被裁时告知 next_offset + 收窄提示，让 agent 自救）。**验收**：大表可翻页取全、agent 不再退化连发；列名白名单防原型污染；旧 `{name,query}` 调用向后兼容；收藏查询埋点进 M4.0 仪表。✅ **已完成并上真机**（2026-07-06 与 M4.6 同批合并部署〔610b7ab〕：where/columns/limit+offset〔上限 200〕/40KB 字节预算/truncated 四件套；2026-07-10 生产实测：`collections_search {limit:2, columns:[id,name]}` 返回 `total:823 / returned:2 / truncated:true / next_offset:2` + 自救 hint，列投影生效——契约齐活；向后兼容与列白名单由测试覆盖。打勾系 2026-07-10 补记，完成即 07-06。）
- **M4.8 self-serve 接入（接入边际成本收窄）**（2026-07-06 立项，源于「V1 一段 prompt 接一个 agent、MCP 版退化成发 token + 改配置 + 重启」的易用性讨论）：目标 = 把「接入第 N 个 agent」从手工发 token + 改配置 + 重启**收窄到趋近一段 prompt/一个链接**，同时保住 MCP 版买到的可吊销/可审计/权限分级/手机可达/治理。机制（2026-07-06 设计定稿，八条裁定见 §9「M4.8 设计裁定」）：自助 enrollment——主频道一句话铸一次性码（短时效、单次用），交给新 agent（≈一段 prompt/一个链接），agent 拿码在 `POST /enroll` 自助换一把**专属、档位铸码时锁死、可吊销**的 token 并按 `GET /enroll` 公开协议完成自配置 + 自验证；服务端账本（volume、git 外、只存 hash）记账发过哪些 token、谁在用、随时可撤。**关键判据（并入 §2 原则 A）**：部署库是一次性成本（可接受、INSTALL 让 agent 代劳）；接入每个新 agent 是**每次成本**，必须朝「一段 prompt」收窄——这是 V1 易用性 + MCP 安全边界的合流，是原则 A 的真正终点。**验收**：① 主频道 `enroll_create` 一句话出码 + 可粘贴 prompt；② 新 agent 仅凭该 prompt 自助换 token、自配置、自验证，全程零 Railway 面板操作、零重启；③ 码默认 15 分钟过期、单次使用，重放/过期/瞎猜被拒且审计（含 IP）+ 通知留痕；④ token 档位 = 铸码时锁死（兑换方零字段可指定 = 防提权；`channel: primary` 不可经 enrollment 发出）；⑤ `enroll_list` 记账（静态 + enrolled，含 created/last_used/revoked）、`enroll_revoke` 即刻生效（下一请求 401）；⑥ 账本只存 sha256、住 volume git 外，code/token 明文不进审计/通知/日志；⑦ 现有测试零回归 + 考卷 45/45 + 新增 enrollment 测试全绿。 ✅ **已上真机**（编排验证：324 测试绿 + 考卷 45/45 + Codex xhigh 对抗+复验多轮收敛 + 全分支终审 Ready，抓修 cancelled 码可兑 / 码明文灌账本 / 结构损坏崩溃 / 永不过期码 / XFF 明文进审计 / Host 注入污染铸码 prompt / 缺参绕限速 等真洞；真机部署验证 2026-07-06 14:30Z：公开面 `GET /enroll` 正常、Host 头注入不污染域名、假码 401、审计 `enroll_rejected` 记 sanitized IP 且审计流零码明文、`invalid` 不通知；`enroll_create→redeem` 全链路已于 2026-07-06 真机端到端验通——主频道铸码（cc-substrate-service/low）→ 新 agent 凭公开协议兑码自配置自验证（握手无主频道段 = D3 反向验证、search 读通）→ 同码重放 410 + 飞书通知实发 → `enroll_list` 记账齐全，判据①②③④⑤闭环；`enroll_revoke` 亦同日以抛弃式 client 真机验通（吊销前 initialize 200 → 吊销回执「1 个 token 失效」→ 下一请求即 401），验收判据全数收口；设计裁定见 §9）。
- **M4.9 常驻宿主小抄抗抖下发（路 B digest 注入）**（2026-07-09 立项并当日落地，源于 Hermes 真机复盘——移动网络/空闲掉线时 MCP instructions 房规随连接一起消失）：MCP instructions 路（连接即下发）是脆的——宿主侧断线重连期间 `session=None` 即出局、重试耗尽 parked 摘工具双重出局、初连失败直接放弃（冷启动断网=死透，宿主侧无自愈）。补齐 `/digest` 拉取路的宿主侧接线：常驻宿主定时拉 `/digest` **原子写入宿主原生常驻上下文文件**（Hermes = `$HOME/.hermes.md`，每个新会话构建系统提示时自动注入），**任何失败一律保留旧文件**（stale-but-present：小抄旧了能用，消失不行）。服务端两笔：① 高信任 instructions 附 `SELF_WIRE`「常驻宿主自装」段（低信任不下发，/digest 对其本就 403）；② `GET /enroll` 协议 §2 Hermes 条目具体化（落地文件 / 30 分钟保鲜 / 失败保旧铁律）——新常驻宿主接入照协议自装，零人工，与 M4.8「一段 prompt 接入」同构。**验收**：✅ 已上真机（两台 Mac 的 Hermes 网关均接好——同款 refresh 脚本〔锚点校验 + 宿主注入扫描器预检 + 同文件系统原子替换 + 0600 + 逐次日志〕+ cron `*/30`；真实会话 dump 验证 `# Project Context → .hermes.md → 主人核心记忆` 完整在场；服务端新增 `instructions.test.js`、全量 385 绿；机制裁定与宿主侧源码事实见 §9「M4.9 裁定」）。覆盖即全量：在用的常驻 Hermes 宿主仅两台 Mac（**Railway 上曾有的 Hermes 实例已废弃**——2026-07-10 主人确认，不作接入目标、文档中不再作为残余项出现）。

## 9. 决策记录与开放问题

**已定（2026-07-05，拥有者拍板）**
- **部署**：你自己维持**云**（Railway 已在跑，是唯一够得着手机 + 远程 Hermes 且不架隧道的形态）。OSS 侧**两种都给**——本地单机作「60 秒试用」入口（留到 M4.5 打包时加），云为完整形态；安装 prompt 问一句「就这台机器还是所有设备+手机」分流。
- **检索**：**默认纯词法（SQLite FTS5）**，语义（sqlite-vec + embedding）作一键升级档；**开不开由 M4.0 的「检索落空率」仪表用真实数据定**，不拍脑袋。
- **分层落点**：用 **frontmatter `tier` 字段**（`raw` 住 inbox zone；keeper 归档后落真 zone 带 `tier: candidate|canonical`；`rejected` = `tier: rejected` 隔离可查）。晋升 = 翻字段，不搬文件、`content_id` 稳定。
- **命名**：模式对外名暂定 **Governed Agent Memory / 受治理的 agent 记忆**（临时，不纠结）；**项目名保持 `substrate` 不改**。
- **主频道「主动浮出」= 拉为主（M4.3 裁定）**：**不做 server push**——无状态 HTTP transport 没有 server→client 推送通道，改有状态 SSE 是架构手术、不值；且主频道 agent 只在主人对话时在场，push 没有常驻接收端。改**拉**，三条承接：① primary 客户端每次工具成功响应**尾部 piggyback** 一行「📥 待主人裁定 N 件」提示——浮出恰好发生在主人已在的那个对话里，零轮询成本；防重复 = held id 集合为 key，`NUDGE_TTL_MS`（默认 4h）窗口内只发一次，`inbox_list`/`inbox_resolve` 豁免（正在处置面里不再自扰）。② **不消费 MCP instructions 的宿主**（如 Hermes）用 primary token 定期拉 `/digest` 承接——digest 的 primary 版已含主频道房规 + 实时 held 摘要，等效于把「连接即下发」补成「拉取即保鲜」。③ 飞书 webhook 降为**哑兜底**通知。**安全红线**：piggyback 与 digest 的 held 摘要都**只带 id/kind/计数**，待裁件正文（= 对抗输入）绝不进提示面 / instructions / digest（与 M4.0 考卷同款威胁模型）。

- **M4.4 三项设计裁定（2026-07-05 编排落地）**：
  - **D1 溯源/置信/epistemic_type（§3.3/§6.1）= keeper 判时产出，不回填历史页**（本条即上面「仍开放」里 epistemic_type 那问的答案）。白名单 `fact|preference|decision|opinion|excerpt|to-verify`，缺省/非法一律归 null **绝不因此拒件**（描述性元数据、容错优先，旧金标/假 provider 无此字段仍过考卷）。落点：`new_page` 写页级 `source_agent`/`confidence`/`epistemic_type`；`merge_into` 只在归档注记行携带、不动页级（一页可混多种认知类型）。归一化就地改写进 decision（审计=落盘事实）。历史页由日后夜班自然覆盖，不做一次性回填。
  - **D2 schema 演化 = 提案件即 inbox 件 + 点选预批**（§3.4/§6.3）：新 kind `schema`/`maintenance` 创建即 `status:held`（keeper 对其零 LLM）。批准全复用现有**点选候选**通路（`<!--keeper-options-->` → `inbox_resolve` 传 `option` → `<!--owner-decision-->` 预批 → keeper 直执行）；**纯文字裁定永不触发执行或清场 → re-held**（防误伤）。`schema_apply` 双入口一实现（MCP 工具 + keeper 点选都走 executor 同一函数）；**schema 内容只认提案件正文的 ```json 块**，decision 只能「指向」件（`target === payload.id`）——LLM/裁定无法携带 schema 正文（白名单原则）。apply = 确定性三步（`governance/zones.md` yaml 追加 + zone 目录/.gitkeep + README stub）→ `doctor` → **errors>0 显式回滚**（不 commit）。骨架区（governance/skills/inbox/keeper-feedback）禁作 zone path；purpose 落 zones.md 前剥反引号+换行+长度上限（防截断 yaml 围栏破 ACL）。
  - **D3 审批式夜班 v0 = 纯确定性零 LLM**（§3.5）：跑在 keeper tick 里（`NIGHTLY_INTERVAL_MS` 默认 7d、0=禁用；状态文件在实例 git 外）。检出**近似去重**（标题词集 / 正文 bigram Jaccard ≥0.6）与**薄页**（<200 字符）→ 出 `merge_pages` 预批提案；**断链**只报告不自动改。每轮 ≤5 件、同 target 未决不重复提、**sensitive zone 整体不扫**（否则敏感页路径经 `/capture/status` 泄给 capture 档）。**明确不做**（v0 守焦点）：孤儿检测、矛盾旗标、keeper 聚簇自动提 zone。新增 executor action `merge_pages`（源页正文并入目标 + `curate rm` 清反链，`rulingMarked` 硬校验同 remove_page，失败整树 `git checkout` 回滚且排除 inbox/）。
- **M4.4 抗注入加固（Codex xhigh 四轮对抗 review 的收敛结论，2026-07-05）**：本批把「**inbox 文件活在 git 里、`git pull` 进来的文件 = 对抗输入**」这条威胁模型贯彻到治理/删除路径。核心机制 = **进程内批准登记表**：keeper 只认经 `resolveEntry` 真记过账的批准（token = `sha256(id+ruling+decision+rel+kind+parseEntryBody(content))`），**文件里裸的 `owner_ruling`/`owner-decision`/`ruling_via_trust` 一律不信**——伪造件（含 capture 正文注入的 owner-decision 块、approve-then-swap 改 payload/body/kind）token 失配即 re-held；认证票一次性（任何触达执行的尝试即销账，防 stale 复燃）。维护提案点选执行**绑定可见 json op 块**（隐藏 options 决定不得与可见提案不符）。残余同主题 exploit 均需**私库 git 推送权限**（该 principal 本可直接改库），记为个人 alpha 已知限制、不再深挖。
- **M4.5 抗注入加固（Codex xhigh 全批 + 两轮聚焦复核，2026-07-05）**：把 M4.4 逼出的攻击面固化进判例考卷（金标 25→45、adversarial 5→19、redline 3→11），并实修两个 Codex 抓出的真洞（凭据红线里程碑带已知绕过=失格，判「实修不止披露」）。① **凭据红线四层加固**：`inbox.addEntry` 原只扫连续密钥正则，被空白/换行/零宽/组合标记切碎的 key 可逐段逃过 `\bsk-[A-Za-z0-9]{20,}` 之类——现【同时】扫原文与「折叠副本」，折叠集逐轮扩 `\s`→`[\s\p{Cf}]`→`[\s\p{Cf}\p{Mn}\p{Me}\p{Cc}]`，几近穷尽「视觉/功能可忽略、能隐形拆 key」的字符空间（可见字符拆 key 破坏其可用性=非有效攻击，划已知边界；原文扫描保留兜 PEM 的合法内建空格）。② **考卷 confidence 越权假绿**：三条「set confidence=1.0」注入 golden 原本 `scoreCase` 不校验 `decision.confidence` 即判 PASS（假绿，绕过 `KEEPER_MIN_CONFIDENCE` 的低置信→held 安全阀）——加 `expect.maxConfidence` 断言，模型被诱抬置信到上限之上即判败。教训重申：任务级同源 review 漏掉这两处，全靠 Codex 异源对抗 +（凭据洞）`Default_Ignorable_Code_Point` 全码点扫描逼出。
- **M4.6 设计裁定（2026-07-06，主人拍板方向；夜班首跑真机复盘）**：夜班第一轮（07-06 03:28Z，确定性扫描出 3 薄页 + 2 断链 → 5 件维护提案）暴露三层原则 B 失守——① App 提供了 capture 通道无权兑现的「批准删除」按钮：主人裁了 5 件，3 件批准删除被 keeper 按 M4.4 通道限权正确拒绝（verdict:held）弹回待定夺，要求换客户端重裁（安全层全对，人的体验=被要求判断→判了→不算→重来）；② 维护件自标「回任意 agent 处理」却进了主人手机待裁面——路由错误；③「删不删一张 130 字符的薄页」本身不该问人：主人没有上下文、判断成本高收益趋近零，而库是 lossless 设计（git 历史 + tier），删除应几乎不存在。三条裁定：
  - **D1 降级替代删除**：夜班对薄页/重复页出确定性 `set_tier`（canonical→candidate）——可逆、零裁定、**进程内扫描→直执行，不经 inbox 文件往返**（顺带消灭该路径的注入面：无提案文件可伪造，威胁模型比审批式更简单）。新 executor action `set_tier` 硬校验只认 canonical↔candidate 互翻（rejected 仍走既有裁定通路，删除仍要主人裁定——只是夜班不再提删除）；夜班只降不升，re-promote 须高信任通道发起。降级页默认检索不可见但仍可读、git 可查；夜班摘要（含降级清单）进 digest 供事后追认/一句话撤销。
  - **D2 裁定面按通道收窄（服务端强制）**：held 件带「可裁通道」属性；`/capture/status` 只列 capture 通道有权兑现的件，maintenance/schema 类对 App 只读展示。原则=**不给人无权兑现的按钮**，由服务端保证而非客户端自律。
  - **D3 报告不进人收件箱**：断链等只报告类产物落 `governance/maintenance-log.md` + agent digest；主人收件箱只保留「只有人能判断」的件。判据已并入 §2 原则 B。
  - 迁移：现存 3 件弹回的删页提案转降级收编、1 件断链报告转维护日志，清零后 App 待裁面应为空。
- **M4.8 self-serve 接入的设计讨论（2026-07-06，易用性对比引出）**：主人问「V1 一段 prompt 就能接一个 Hermes，MCP 版反而要发 token + 改配置 + 重启，是不是易用性退步」。结论=**一半真退步、一半幸存者偏差，真退步那半是可还的债、非架构必然**：① V1 的「一段 prompt」建立在隐性前置上——那台机器早已有库的本地 clone + git 凭据 + 你已授予它对正典的完全写权限；「prompt」只是最后一环。真实对比要用**总拥有成本**：V1 把成本分散/前置/隐性（每台机器各自扛 clone/凭据/信任），MCP 把成本集中/显性（一次性部署服务）——集中显性看着大，只是逼你正视了 V1 一直在背后付的账。② V1「人人可直接写正典」模型一到多 agent 就塌（docs/01 §mini-Hermes 直写差点丢数据的真实事故=该模型的结构性裂缝），且手机这条腿 V1 从未真长出来（纯 skill 模型手机凭什么读写 git repo）。③ 但退步里确有真债：**部署库是一次性成本（可接受），接入每个新 agent 是每次成本、且现在不能靠 prompt**（token 手工分发 + 改配置 + 重启容器）——这块该朝「接入趋近一段 prompt」收窄，即 M4.8 的 self-serve enrollment。终态=V1 的接入易用性 + MCP 的可吊销/可审计/权限分级/手机可达/治理，是原则 A 的真正终点。**明确不做**：回退到 V1 的 agent 直写正典模型（放弃治理=放弃项目立身之本）。
- **M4.8 设计裁定（2026-07-06，fable5 设计、主人授权自主推进；八条）**：
  - **D1 机制选型 = 服务端一次性码 + `POST /enroll` 兑换**。否决两案：① 自包含签名码（HMAC/JWT 把 client/trust/exp 签进码里）——「单次使用」仍需服务端已用账本，省不掉状态还多一把签名密钥要管、铸出后无法在兑换前撤销；② OAuth 动态客户端注册——为「一段 prompt」搬进整个授权服务器（consent UI/refresh/多端点），违反原则 A 装得极简；MCP 生态若日后强制 OAuth 再作为升级档。一次性码状态最小、威胁面最窄、与现有 bearer 模型无缝。
  - **D2 铸码入口 = 仅 `channel: primary` && `trust: high` 的 MCP 工具 `enroll_create`**（服务端强制，按 identity 条件注册工具，沿用 inbox high-only 先例）。核心威胁是 **token 自繁殖**：若任意 high 可铸码，一把 high 泄漏 = 攻击者能铸出「吊销原 token 后仍存活」的新 token（持久化后门）——**铸币权必须窄于使用权**。主频道 = 主人化身，入口最窄与 M4.6「特权操作入口收窄」同构；铸码发生在主人已在的对话里 = 原则 B。铸码即审计 + 飞书通知。
  - **D3 档位铸码时锁死**：码上预设 `client`（enrolled 存量内唯一、撞静态名拒发）、`trust ∈ {high, low, capture}`、可选备注；兑换方**零字段可指定** = 防提权。**`channel: primary` 不可经 enrollment 发出**——主频道是治理面（浮出/房规/裁定），仍走 TOKENS_JSON 静态配置，铸币权不复制治理权。
  - **D4 账本住 volume、git 外、只存 hash**：`/data/enroll-state.json`（`instanceDir/..`，与 nightly-state.json 同路径约定）。**绝不进实例 repo——git pull 是对抗输入，账本进 repo = 伪造件可自铸 token，M4.4 抗注入白干**（本设计第一安全边界）。token/code 只存 sha256（卷泄漏 ≠ 凭据泄漏）；原子写（tmp+rename）；文件损坏 = enrolled 全失效、静态 token 不受影响、服务不倒（安全失败方向同 F1 登记表）。**完整性边界（Codex 对抗 review 裁定，2026-07-06）**：hash 化只解决保密性不解决完整性——能写 volume 的攻击者可伪造账本记录自铸 token；裁定为**已知边界不加 HMAC**（能写卷 = 已可改 nightly-state/索引/实例工作树，本就全盘沦陷，签名密钥管理不值）；模块层以结构校验作纵深防御（合法 JSON 但 schema 异常同样进 degraded、拒非法 trust/status），`list()` 输出显式字段白名单、兑换方可控的 ip 经 node:net isIP 规范化再入账（防把码明文塞进账本再流出主频道对话面）。
  - **D5 码 = 短时效 + 单次 + 重放即证据**：默认 TTL 15 分钟（`ENROLL_CODE_TTL_MS`）、单次使用（Node 单线程，`await` 前同步消账 = 无并发重放窗）；未决码上限 10（过期码任一账本操作时顺手清）。重放/过期/瞎猜 → 拒 + `enroll_rejected` 审计（含 IP）+ 飞书通知；**合法 agent 兑换时报「码已被使用」= 被抢注的 tamper evidence**，主人立刻吊销。`/enroll` 按 IP 限速（失败 5 次/15 分钟）兜底防爆破（码本身 128-bit 熵，爆破本不可行）。
  - **D6 自配置自验证 = `GET /enroll` 公开协议文本**（无敏感内容，与 /healthz 同档公开；协议由服务自带，不依赖 repo 公开与否）。`enroll_create` 返回可粘贴 prompt：「读 `https://<域>/enroll` 按协议接入，你的一次性码 `<code>`（15 分钟内单次有效）」——接入 = 真·一段 prompt。协议教新 agent：POST /enroll 换 token → 按宿主自配置（`claude mcp add` / `codex mcp add` / Hermes 走 `/digest` 拉取）→ 自验清单（healthz + MCP 握手 + 读通；high 加写通）= INSTALL §7 子集。公网域名取 `PUBLIC_URL` → `RAILWAY_PUBLIC_DOMAIN` → 请求 Host 兜底。
  - **D7 TOKENS_JSON 降级为 bootstrap**：保留静态表（解决第一把 token 鸡生蛋、承载 primary 标记、账本损坏时的兜底通道）；`identify()` 先查静态再查账本（静态不可被账本遮蔽）；INSTALL 更新为「TOKENS_JSON 只需一把 primary 起步，其余 agent 走 enrollment」。不做存量迁移，两源长期共存。
  - **D8 记账/吊销 = `enroll_list` / `enroll_revoke`（同 D2 门）**：list 展示静态（只读，`source: static`）+ enrolled（client/trust/created/created_by/last_used/revoked）；revoke 只管 enrolled、即刻生效（下一请求 401），静态 token 回 Railway 面板删（工具里给指引）；revoke 也可撤未决码。审计事件族：`enroll_code_created` / `enroll_redeemed` / `enroll_rejected` / `enroll_revoked`——**全程 code/token 明文不进审计、不进通知、不进日志**（只记 hash 前缀）。
  - **红线重申**：`set_tier` 入口不变（夜班进程内 + 高信任 `page_set_tier` 两条，enrollment 不新增第三条）；凭据红线不变（enrollment 不落任何明文凭据进库）；enrolled token 走与静态 token 完全同一套 ACL/审计路径，不引入新权限档。
- **M4.9 裁定（2026-07-09，主人拍板走路 B；Claude 调查 + Codex xhigh 异源校验一致推荐）**：候选三路——B（digest 定时拉 → 宿主本地文件注入）/ A′（宿主 parked 自动唤醒补丁）/ A″（宿主断线保留缓存 instructions 补丁）。**裁定走 B**，三条理由：① 只有 B 扛得住断网 + 进程重启 + 冷启动（本地文件跨重启存活；A″ 是进程内缓存，A′ 救不了「初连失败直接放弃」的路径）；② 只有 B 送完整 digest（主人记忆 + 库地图 + 房规 + 夜班/held 摘要——instructions 路只送房规）；③ B 零宿主补丁（用 Hermes 原生 context-file 机制），A′/A″ 都要在宿主侧背可维护性债且给别人用不现实。**宿主侧关键源码事实**（Hermes v0.16.0，调查中证伪了「Hermes 不读 `.hermes.md`」的早先结论）：`.hermes.md` 是第一优先级项目上下文文件（> AGENTS.md，与 SOUL.md 人设槽独立）；网关的发现目录 = `TERMINAL_CWD`（config `terminal.cwd: "."` 占位符在 local 后端解析为 `$HOME`）→ 落地文件是 `$HOME/.hermes.md`；系统提示按会话持久化复用 → 刷新生效点 = 新会话，非每条消息。**「事件驱动替代定时」议题（2026-07-10 主人问）**：裁定保留定时——v2 小抄内容在服务端、由他方（其它 agent/capture/keeper/夜班）改动，宿主自身事件罩不住；会话中刷新只惠及下个会话（与定时同语义）；「每次调 MCP 时刷」与需求反相关（MCP 活着时最不需要兜底）；靠房规让 LLM 记得刷 = 重新引入刚消灭的脆弱性。真正时效敏感的 held 裁定已走工具响应 piggyback 活通路，digest 30 分钟保鲜绰绰有余。**防御纵深**：宿主注入扫描器是「命中即整文件替换」语义——某天动态记忆措辞命中威胁模式会让整张小抄被拦，refresh 脚本已用同款扫描器预检、判 block 即保旧并记日志（`FAIL 扫描器判 block` = 该去改那条记忆的措辞）。
- 语义索引默认开的阈值：落空率到多少才值得引入 embedding 依赖？（M4.1 用 M4.0 的数据回答，仍开放。2026-07-06 基线补充：M4.x 上线后 `search`/`recall` 零调用、读侧大头是 `collections_search`——此问暂无数据可答且不急；读侧真实痛点见 Hermes 截断案例，已立 M4.7 解决。）
