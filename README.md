# substrate-service

Substrate 个人知识库的服务化访问层：MCP server + keeper 守门 agent + 捕获入口。

- 方案与里程碑：[docs/README.md](docs/README.md) → [docs/01-personal-alpha.md](docs/01-personal-alpha.md)
- 长期产品化：[docs/02-productization.md](docs/02-productization.md)
- 存储层引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)

## 仓库状态

- **M0**（连通性实测）：✅ 通过，定 Railway（数据见 docs/01 决策记录）。
- **M1**（MCP 只读）：`service/` 已部署——5 读工具 + zone ACL + bearer 认证 + 审计 + 实例 git 跟随；待拥有者 CC 接入验收。
- M2（keeper 写通）/ M3（捕获 + App）：未开始，规格见 docs/01。

## 目录

```
docs/       方案文档（迁自 substrate-service-plan/，含决策记录）
service/    MCP server（Node 22 + 官方 SDK，Dockerfile 部署 Railway；npm test 跑全部测试）
m0-hello/   M0 连通性实测用的最小服务（一次性脚手架，已退役留档）
```
