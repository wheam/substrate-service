# substrate-service

Substrate 个人知识库的服务化访问层：MCP server + keeper 守门 agent + 捕获入口。

- 方案与里程碑：[docs/README.md](docs/README.md) → [docs/01-personal-alpha.md](docs/01-personal-alpha.md)
- 长期产品化：[docs/02-productization.md](docs/02-productization.md)
- 存储层引擎（开源、独立仓库）：[substrate](https://github.com/wheam/substrate)

## 仓库状态

- **M0**（连通性实测）：`m0-hello/` —— Railway 上的 hello 端点 + 三位置延迟实测。
- M1（MCP 只读）/ M2（keeper 写通）/ M3（捕获 + App）：未开始，规格见 docs/01。

## 目录

```
docs/       方案文档（迁自 substrate-service-plan/，含决策记录）
m0-hello/   M0 连通性实测用的最小服务（一次性脚手架，M1 后退役）
```
