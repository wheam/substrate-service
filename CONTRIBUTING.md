# 贡献指南 — substrate-service

substrate-service 是「受治理的 agent 记忆（Governed Agent Memory）」的 **MCP 版参考实现**：一个中心化服务——MCP server + keeper 守门 agent + 捕获端点，持有并唯一维护一份 markdown + git 的知识库实例。它是 [substrate](https://github.com/wheam/substrate) 引擎的服务化访问层。贡献请守以下几条。

## 红线（PR 必过）

1. **零凭据入库**：任何密钥 / 凭据原文**绝不进库、不进测试、不进提交信息**。inbox 有 `CREDENTIAL_PATTERNS` 扫描拦截；写任何文件前先自查。
2. **零个人信息**：不含真实人名、具体机器 / 网络、私有路径、真实域名、某个用户的偏好；示例、测试一律用占位符。
3. **LLM 只判断、代码才执行**：keeper（LLM）只产出结构化的「决定」（JSON），写入永远走确定性执行器；**任何「让 LLM 直接动文件」的改动一律拒**。这是项目立身之本（可回归 + 抗注入的前提），不是可协商的实现细节。
4. **抗注入**：inbox 文件活在 git 里、`git pull` 是对抗输入。治理 / 删除路径只认**进程内批准登记表**记过账的批准，别信文件里裸的 `owner_ruling` / `owner-decision`。改动这些路径前先读 docs/03 §9 的抗注入裁定。

## 怎么改

- **契约先行**：动工具面 / frontmatter 字段 / inbox 状态机，先对齐 **docs/03**（数据模型与契约）再改实现。
- **YAGNI**：字段、机制从最小集起步，需要再长。
- **判例考卷是护城河**：改 keeper 系统提示 / 换模型 / 动准入逻辑，**必跑判例回归考卷**；通过率不达标不合并。keeper 判得准 = 产品质量。
- **安全默认**：新增能力默认最小权限；capture 通道无权删页 / 触发治理（不给人无权兑现的按钮）。
- **两条硬原则**（贯穿一切）：装得极简（趋近一段 prompt）/ 用得几乎零负担（能降级为可逆自动动作的就别问人）。见 docs/03 §2。

## 提交前自检

- `cd service && npm test` —— 必须**全绿**（含判例回归考卷；CI 用假 provider 离线跑，真模型走带 key 的 gated run）。
- 改了 keeper 判断相关：判例考卷通过率**不降**。
- 全仓扫一遍：无凭据、无个人信息、无真实域名 / 私库名。
- 复杂改动建议找一个**不同模型**做异源对抗 review（同源 review 会漏威胁面，实测多次）。

## 提交信息

中文、present-tense，写清 **what + why**。不加 `Co-Authored-By` / `Claude-Session` 之类 trailer。

## 分支与部署

本仓库 `main` 接了自动部署——**合并进 `main` = 生产上线**，由维护者把关。请针对**开发分支**提 PR；`main` 只放可发布状态。
