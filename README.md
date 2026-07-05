# substrate-service

Substrate 个人知识库的服务化访问层：MCP server + keeper 守门 agent + 捕获入口。

- **给 agent 装一套**：[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) —— 把它交给你已有的 agent（CC / Codex / Hermes），它按协议把服务搭起来。
- 方案与里程碑：[docs/README.md](docs/README.md) → [docs/01-personal-alpha.md](docs/01-personal-alpha.md)
- 长期产品化：[docs/02-productization.md](docs/02-productization.md)
- 下一版 spec（M4.x）：[docs/03-next-version-spec.md](docs/03-next-version-spec.md)
- 存储层引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)

## 仓库状态

- **M0–M3**（个人 alpha）：✅ 已上真机——连通性实测（定 Railway）、MCP 读工具 + zone ACL + bearer 认证 + 审计、keeper 写通、捕获端点 + iOS App。详见 docs/01。
- **M4.0–M4.2**：✅ 主人已验收——仪表 + 判例考卷（M4.0）、读侧智能（`recall` + 可抛 FTS5 索引 + `content_id`，M4.1）、lossless 分层（`tier` 贯穿写入/检索，M4.2）。
- **M4.3**（主频道 agent + 装 prompt）：✅ 已验收（主人授权编排验证：181 测试绿 + 端到端 15 项实测 + Codex xhigh 两轮对抗 review merge-ready）——主频道 `channel:primary` 标记 + 待裁件主动浮出（piggyback + digest）+ [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) 安装协议。
- **M4.4**（溯源 frontmatter + schema 演化 + 审批式夜班）：✅ 已验收（编排验证：244 测试绿 + 考卷 25/25 + 端到端烟雾 18/18 + Codex xhigh **四轮**对抗 review 收敛至 merge-ready）——`source_agent`/`confidence`/`epistemic_type` 落盘；新 zone 提议→主频道点选批→落地 doctor 0 error；夜班确定性扫描出预批维护提案走 inbox。抗注入核心 = 进程内批准登记表（只认 `resolveEntry` 记账的批准，`git pull` 伪造件一律 re-held）。详见 docs/03 §9。

## 目录

```
INSTALL_FOR_AGENTS.md  给 agent 的一段安装协议（交给你的 agent，它把服务搭起来）
docs/       方案文档（迁自 substrate-service-plan/，含决策记录）
service/    MCP server（Node 22 + 官方 SDK，service/Dockerfile 部署 Railway；npm test 跑全部测试）
app/        iOS 捕获 App（/capture 投递端 + 分享扩展，实验件）
m0-hello/   M0 连通性实测用的最小服务（一次性脚手架，已退役留档）
```
