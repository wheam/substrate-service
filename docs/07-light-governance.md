# 轻治理可信直写（个人双 Agent 试用档）

这个模式面向“一个 owner + 少数明确可信 agent”的实例。它不把知识库退回多份本地 clone，也不关闭 Substrate 的确定性安全边界；它只把 Keeper 从**每条普通知识写入的必经语义门**，调整为**目标不明确时的路由器 + 高风险治理门 + 后台养护者**。

默认行为不变。没有显式授权的客户端仍全部按原 `save → inbox → Keeper` 流程工作。

## 如何授权

只对 `trust: high` 生效，二选一：

1. 静态 `TOKENS_JSON` 项增加 `"write_mode":"direct"`：

   ```json
   {
     "<codex-token>": { "client": "codex-main", "trust": "high", "channel": "primary", "write_mode": "direct" },
     "<hermes-token>": { "client": "hermes-main", "trust": "high", "write_mode": "direct" }
   }
   ```

2. 环境变量 `TRUSTED_DIRECT_CLIENTS=codex-main,hermes-main`。这也适用于通过 enrollment 接入、无法在静态 token 元数据里加字段的客户端。

两者都只按服务端已经认证的 `client` 生效；low/capture 即使误配也不能直写。撤销试用只需删掉 `write_mode` 或从 `TRUSTED_DIRECT_CLIENTS` 移除客户端并重启服务，数据格式不需要迁移。

## `save` 的双路径

原参数保持兼容：

- `save{content, hint?}`：仍进 inbox，由 Keeper 判断目标。
- `save{content, path, mode, expected_content_id?}`：授权客户端请求可信直写。

`mode` 只接受：

- `create`：目标必须不存在；服务生成标准 frontmatter 和 `content_id`。
- `append`：目标必须已经是普通文件；只追加一个带来源和日期的块，不做整页覆盖。目标有 `content_id` 时建议传 `expected_content_id`，不一致则安全失败。

示例：

```json
{
  "name": "save",
  "arguments": {
    "content": "决定：先试用两周轻治理，再看 Keeper 实际拦住了什么。",
    "path": "knowledge/substrate-decisions.md",
    "mode": "append",
    "expected_content_id": "1234abcd"
  }
}
```

只有响应明确写出“已可信直写”才表示已正式入库。没有明确路径、目标可能重复或需要语义判断时，agent 必须省略 `path/mode`，回退 inbox。

## 仍然保留的硬边界

可信直写并不等于任意文件写入：

- 只允许已注册普通内容 zone 中的 Markdown 页面；
- 只允许 create/append，不允许 replace/delete/move；
- 拒绝 `skills/`、`governance/`、`inbox/`、`keeper-feedback/`；
- 拒绝 `README.md`、`_*`、隐藏路径和符号链接父路径；
- `todo`、`collections` 等 typed zone 仍走专用工具与原治理链；
- Skill staging/晋升、schema、核心摘要、删除、合并等仍走专用审核流程；
- 凭据扫描、单文件 1 MiB 上限、effect policy、单写者 Git 事务、doctor 和失败回滚全部保留；
- 所有直写调用记 `direct_write` 审计事件，正文继续脱敏不入审计。

## Keeper 在轻治理档的角色

Keeper 仍处理：

- 没有明确安全目标的自由文本；
- `remember`、typed 写入和既有兼容入口；
- owner-held 冲突与高风险提案；
- Skill / schema / core 等治理闭环；
- nightly 去重、薄页、断链与陈旧内容养护。

当前版本没有把每次可信直写再异步交给 LLM 复判，避免“前门绕过了 Keeper、后台又逐条收税”。夜班仍可从全库层面发现维护问题。

## 诚实限制与试用建议

- 直写要求 agent 能明确选择路径；不确定时仍需要 Keeper。它消除的是“目标已知却还要等待 LLM”的成本，不是免费解决语义分类。
- 轻治理主动缩小了 inbox 隔离面：如果一个获授权 high agent 自己被提示注入、并违反“只有主人授权才保存”的房规调用了 `save{path,mode}`，攻击最多可直接污染普通内容页，而不再先停在 inbox。Skill、治理、删除、覆盖和结构动作仍被代码拦住，Git 可恢复，但这并非与严格模式等价；只应授权实际主用、行为可靠且可单独吊销的 Hermes/Codex token，外部 capture 永不授权。
- `append` 是追加，不是结构化合并；长期可能形成较长的时间块，交给夜班或人工后续整理。
- 无 `DEEPSEEK_API_KEY` 时，可信直写仍可用，但 inbox 件不会自动归档、`recall` 也不注册。
- 建议先只授权 Hermes 与 Codex 两周，观察 `direct_write` 数、inbox 回退数、owner-held 数、doctor 拒绝和实际写错次数，再决定是否进一步缩减 Keeper。
