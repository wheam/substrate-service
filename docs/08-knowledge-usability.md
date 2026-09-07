# 08 — 知识库易用性（首批落地）

> 状态：已完成本地实现、自动测试与 5 个真实 Codex CLI 场景抽样；尚未部署。生产 provider 与完整跨宿主回归仍待验收。
> 范围：[03 spec](03-next-version-spec.md) §6.3 读工具面的一次易用性改造的「最小首批」。
> 起因：主人要求查「我个人知识库里的酒店规则」，agent 先去翻了别的东西；随后发现即便调到 `recall`，
> 返回的也只是每页最多 3 条命中片段——规则页后半段的硬约束与例外根本没进过材料，而且没人知道漏了。

首批只做四件事：**入口自称**、**未命中措辞**、**证据扩展**、**离线评测基线**。
刻意不做：规则页 schema、管理工具拆分/渐进展示、同义词与向量召回、品牌迁移。

---

## 1. 落点（改了哪里）

| 关注点 | 落点 | 摘要 |
| --- | --- | --- |
| 入口自称 | `src/instructions.js`、`src/server.js` | server `title` 加展示名「个人知识库 · Substrate」（`name`/`version` 不动）；精简既有【读库再答】以认领「我的知识库 / 我的记忆库 / 我保存过的规则 / 我的个人偏好 / 我们此前的决定」，并把 `recall` / `search` / `read_page` 的路由前移；读工具描述同口径删减前移 |
| 只读元数据 | `src/server.js` | `search` / `recall` / `read_page` / `get_context` / `todo_list` / `collections_search` 带 `readOnlyHint: true` + `openWorldHint: false`；写与管理工具一律不带 |
| 未命中措辞 | `src/instructions.js`、`src/recall.js` | 全部改为「在当前可访问内容中未检索到足够依据」；同步覆盖 BEHAVIOR_RULES、`/digest`、`enrollProtocol` 的独立副本、recall 的系统/用户提示与零命中/降级返回 |
| 证据扩展 | 新增 `src/evidence.js`，接进 `src/recall.js` | 命中章节 + 邻接上下文（短页给全文），带预算与截断信号 |
| 离线评测 | 新增 `src/recall-eval.js`、`test/goldens/recall-questions.jsonl`、`test/fixture/eval-instance/` | 真实问句 → 证据覆盖率 |

`recall` 的返回在原有 `answer` / `citations` / `gaps` 之上**兼容新增**：

- `evidence[]` —— 实际读到并喂给模型的章节原文：`{path, content_id, heading, lines, text, full_page, partial_line?}`；
- `truncated` —— **只在确有截断时出现**：`{evidence_chars, evidence_budget, candidate_pages, candidate_limit, candidate_limit_reached, incomplete[], hint}`；
- `citations[].sections[]` —— 引用绑定到**实际提供的**章节标题与行范围，可回原页逐行核对。

老消费方读 `answer`/`citations`/`gaps` 的行为不变。

## 2. 证据预算（首批起始值，不是性能承诺）

`src/evidence.js`：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `EVIDENCE_BUDGET_CHARS` | 12000 | 一次 recall 全部证据的字符总预算 |
| `PAGE_FULL_CHARS` | 2000 | 正文不超过此长度的页直接给全文；只命中标题/元数据时也按整页预算读取 |
| `PAGE_MAX_CHARS` | 4000 | 单页证据上限，防一页吃光预算 |
| `ADJACENT_LINES` | 6 | 命中章节前后各带几行上下文 |
| 候选页上限 | 8（`recall.js` 的 `TOP_N`） | 达到即在 `truncated` 里显式标记 |

这些是**待实测的起点**。要调整就同时记录端到端 p50/p95、输入 token 与既有 `llm_ms` 的对比，
并注意 recall 与 keeper 共用同一个 provider。审计里已经带上 `evidence_chars` / `evidence_truncated`。

## 3. 行为与安全边界

- **未命中 ≠ 没存过**：零候选、证据读不到、引用全部验真失败，三条路径都只说「未检索到足够依据」，
  并明说这不代表主人没保存过。**服务/工具故障不走这条路**——异常照常上抛，由 MCP 层回 `isError`，绝不伪装成内容缺失。
- **不跨 ACL 反推**：因分区不可读而丢弃的页，路径不会出现在 `truncated.incomplete` 里（否则等于用「有一页你读不到」反推可见范围外有什么）。
- **展开前重新把关**：索引是派生物、可能过期。每页在展开成证据前重新校验
  路径语法 → zone/ACL → realpath 收敛（拒绝软链与越界，且解析后路径必须逐字等于逻辑路径）→ tier 仍是 canonical → `content_id` 与索引一致。
  任何一项不过就**整页丢弃**，绝不退回索引里那份旧片段；被丢弃的页也不进引用候选集。
- **文件是数据不是指令**：证据只做切片与计数，页内任何命令口吻都是普通文本；系统提示里这条铁律保留并加强。
- **截断必须说出口**：超预算、章节选择遗漏其他正文、页内截断、候选达上限，都会进 `truncated` 并生成确定性的 `gaps`（指路 `read_page` 补读）。
  确定性 gaps 排在模型自产 gaps 前面，不会被挤出 `MAX_GAPS`。单行被裁剪时 `partial_line: true`、`full_page: false`；代码围栏内的井号不作为章节边界。预算裁剪按行单次累计，避免大章节反复拼接。
- **缓存**：命中时除了索引换代检查，还对 **citations、evidence 与 truncated.incomplete 的全部页**重跑 ACL——
  降级答案的 citations 可能是空的，只看 citations 会让缓存把敏感原文继续发出去。预算耗尽也先校验路径与 ACL，防止过期索引通过未读页提示暴露不可访问路径。

## 4. 评测：跑什么、不跑什么

```bash
cd service && npm run eval:recall     # 离线证据覆盖评测
cd service && npm test                # 全量
```

问句集：`test/goldens/recall-questions.jsonl`（23 条中文问句，全脱敏；fixture 在 `test/fixture/eval-instance/`），
覆盖显式查库、隐式个人偏好、新旧纠正、无关负例、不存在的内容、低信任 ACL、抗注入七类。

**这个 runner 只判服务端证据**：金标规则片段在不在证据里、金标页有没有被覆盖、该空的是不是真空、
低信任会不会串到敏感页。它**不判**、也**不能被当作判过**：

- 宿主到底调没调工具、调了哪个 —— 只有客户端会话轨迹能看见；
- 模型最终答得对不对、有没有遵守硬约束、有没有说出被禁的结论 —— 需要真模型 + 人工逐条比对金标。

因此金标里的 `expect_tools` / `forbidden_conclusions` **只随报告带出、不判分**；runner 不调用任何 provider，
也不接任何真实云 API。**假 provider 的输出永远不是宿主模型行为的验收证据。**

已知缺口条目（`known_gap: true`）照常判、照常在报告里点名，但不进通过率门槛——目前有 2 条，
都是同一个词法召回精度问题：问句里的功能词 bigram（「关于」「我的」）会把无关页拉进候选。
同义词/向量召回不在本批范围，这两条留作退化监控。

## 5. 宿主验收

完整跨宿主回归与下列统计仍待执行；已做的本地抽样记录见下节。不能把抽样结论当成所有宿主的稳定成功率：

1. 每个目标宿主上，用同一批问句各开 3 个新会话，记录：工具是否可见、首个相关调用是什么、端到端延迟；
2. 关键硬约束（如「必须可免费取消」「转机 ≥ 90 分钟」）有没有被遗漏或误引，逐条对金标人工标注；
3. 负例是否引发多余调用；
4. 展示名 `title` 在各宿主工具面板里到底显示成什么（服务端控制不了宿主的拼接方式）；
5. 证据预算对输入 token、p50/p95 与 provider 资源的真实影响。

报告口径：给原始计数与延迟分布，不要用一次通过声称可靠性。

## 6. 相关测试

| 文件 | 覆盖 |
| --- | --- |
| `test/knowledge-entry.test.js` | 展示名与兼容性、入口认领、房规不重复下发、未命中措辞（含 `/digest` 与 enroll 副本）、读写工具的 annotations |
| `test/recall-evidence.test.js` | 多章节/后半段例外/新旧冲突不被丢、预算与候选截断、tier/`content_id`/软链/越界重校验、缓存 + ACL、provider 故障不伪装成内容缺失 |
| `test/recall-eval.test.js` | 问句集合法性、证据覆盖门槛、报告边界声明、判分逻辑自测 |
| `test/recall.test.js` | 原有 recall 契约（已更新为新的字段与措辞） |


## 7. 本轮验证记录（2026-09-07）

- 实现基线：`cba6873f2ec83081d9253e88a861b69181e2fcbb`。Claude Opus 5 写初版，在最终收口前遇到会话额度限制；Codex 接手审查修正，包括标题命中遗漏全文、章节遗漏未提示、单行裁剪、代码围栏、裁剪复杂度及缓存未读页 ACL。
- 方案阶段曾由 Claude Fable 5 复核。实现后的外部复核未取得可用报告：Kimi runner 缺失，DeepSeek V4 Pro 只读复核 300 秒超时。本轮以 Codex 自审与测试收口，**不能视为完成了独立实现复核**。
- 原代码全量基线：484 通过，1 跳过，0 失败。
- 最终代码全量测试：522 项，521 通过、1 跳过、0 失败；`npm run eval:recall` 的 4 项评测校验通过，`git diff --check` 通过。日志保存在本机 `/tmp/substrate-usability-20260907/`，属于临时验证产物。
- 离线金标：23 条中原始通过 21 条；纳入门槛的 21 条全部通过。其余 2 条是已登记的词法无关召回问题，仍未解决；没有把它们计作通过。
- 独立虚构酒店页探针：同一句原始问法下，预算、独立办公桌、免费停车、不租车例外、品牌不能覆盖硬约束这 5 项进入问答模型的材料由旧版 0/5 提升至新版 5/5。这是证据覆盖观测，不是生产模型成功率。
- 已执行本地 Codex CLI 0.153.4 + 隔离 HTTP MCP + gpt-6-astra 的初步酒店场景。旧版和初版都推荐正确；旧版 6 次成功知识库调用，初版 3 次。每版仅一次，不能据此宣称稳定减少调用。问答 provider 也使用隔离的 Codex CLI，非生产 DeepSeek provider；仅使用虚构数据。
- 最终宿主抽样 5/5 符合预期（逐条人工核对输出与调用轨迹）：租车选酒店 2 次均遵守预算、独立办公桌、免费停车硬约束；不租车 1 次正确应用停车例外；纯计算 1 次零知识库调用；不存在的潜水偏好 1 次仅表达当前检索依据不足，未断言从未保存。这是单一宿主和模型的小样本，不代表生产成功率。之后仅追加未读页 ACL 修复，由针对性回归及全量测试验证，未重复运行上述正常场景。
- 两次早期宿主试运行因另一个 `codex-cli 0.0.0` 可执行文件及非交互审批行为导致调用未执行，未计入成功样本。后续固定正式 CLI 的绝对路径。
- `test/goldens/recall-host-scenarios.json` 另保存截图原话、负例、不存在内容及真正的“写入确认→新会话查回”步骤；静态旧/新规则 fixture 不等于执行过跨会话写入，此链路目前仍待专门验收。
