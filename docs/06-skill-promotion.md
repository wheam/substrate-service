# Skill staging、审核与晋升

本流程只管理 Substrate 实例仓库里的 Skill 内容，不安装 Skill，也不操作 NAS、OpenWrt、Docker 或网络设备。

## 状态与不变量

- `skills/_incoming/<name>/` 是完整候选目录，状态为 `staging`。默认搜索不返回；只有 high 客户端显式 `include=staging` 才可查。路径状态优先于文件自报的 `tier`，所以 `_incoming` 不会冒充 canonical。
- `skills/<name>/` 是已正式收录的 canonical Skill。
- 普通 `save` 只可把新 Skill 写进 `_incoming`；不能创建正式目录。既有 canonical Skill 的更新继续走原有完整 `replace_skill`，两条流程不互相放宽。
- 正式目标存在时，新 Skill 晋升默认拒绝。当前没有“顺便覆盖”的参数。
- 当前所有风险等级都必须经过 primary owner 点选审核；不启用低风险自动晋升。

## MCP 操作

### 1. 暂存完整目录

先调用：

```json
{"name":"save","arguments":{"hint":"path: skills/_incoming/example/SKILL.md","content":"<完整 SKILL.md>"}}
```

根文件有效并由 keeper 落盘后，才可继续保存：

```text
skills/_incoming/example/references/**
skills/_incoming/example/scripts/**
skills/_incoming/example/agents/**
skills/_incoming/example/<其他合法文本资源>
```

supporting file 是普通资源，不要求 frontmatter。每次写入仍要求认证的 `skill:stage` capability，并复验规范化相对路径、父路径符号链接、NUL、单文件 1 MiB 上限。整树审核上限为 200 个普通文件、5 MiB；符号链接和非普通文件拒绝。

### 2. 检查并冻结审核版本

调用 `skill_inspect{name}`。成功结果包括：

- `content_id`：根 `SKILL.md` 的稳定身份；
- `revision`：按排序后的每个相对路径、长度和原始字节计算的 SHA-256，覆盖 supporting files；
- `files`、`file_count`、`total_bytes`；
- manifest 与 capabilities 重算后的 `admission`。

风险判断不信任自报的 `risk_level`。已知危险能力 `shell`、`system`、`network`、`install`、`secrets`、`modify-skills`、`modify-governance`，以及未知、缺失、重复或畸形 capabilities，均为 `manual-audit-required`。纯安全能力显示 `eligible-after-owner-review`，但仍需 owner。

### 3. 创建审核 receipt

调用：

```json
{
  "name": "promote_skill",
  "arguments": {
    "name": "example",
    "content_id": "1234abcd",
    "revision": "<skill_inspect 返回的 64 位值>"
  }
}
```

该工具不会晋升，只创建或复用一条 `kind: skill`、`status: held` 的审核件。owner 可见摘要包含来源、目标、文件数、字节数、capabilities、admission、content_id 与 revision，并提供两个确定性候选：

1. `批准晋升此版本`；
2. `拒绝晋升（保留 _incoming 供修改）`。

同一未决版本重复调用返回同一 receipt，不重复通知。已按同一 receipt 和 revision 成功晋升时返回 `already_promoted`。
多文件 staging 成功不逐文件播报；owner 只收到这条可操作审核通知。staging 校验失败与最终晋升失败仍会明确通知。

### 4. owner 点选并由 keeper 执行

只有 `trust: high` 且 `channel: primary` 的 owner 能在 `inbox_resolve` 中点选该审核件。批准 proof 存在 git 外并绑定完整 inbox 执行信封；修改可见 payload、隐藏 decision、content_id 或整树 revision 都会失配并 fail closed。

keeper 在执行前再次验证 manifest、目录名、整树版本、目标不存在、审核件 native proof 和 owner approval。随后在同一实例 worktree 内原子 `rename` 整个目录，运行实例 vendored 的 substrate doctor，并在同一 writer 事务中提交来源删除、正式目录新增、审核件清场与审计记录。

doctor 或本地提交失败时，目录原子移回 `_incoming`，审计恢复原状，审核件回到 owner-held；该类失败不会进入六次自动模型重试。已有 writer 语义保持不变：本地 commit 成功而远端 push 暂时失败时，本地提交视为 durable，并由持久 `sync_pending` 后台补推。

## 审计

成功记录追加到 `keeper-feedback/_skill-promotions.jsonl`：

```text
version, receipt_id, name, content_id, revision,
approved_by, approval_channel, approved_at,
source, target, completed_at, result
```

幂等成功要求审计记录与当前 canonical 整树同时匹配；仅有目标目录或仅有损坏审计都不算已成功，会安全报冲突。

## 结构化错误码

由 staging/晋升校验产生的领域错误以 `[CODE]` 开头；MCP 仍按现有工具协议返回 `isError`。doctor、git、provider 等基础设施错误沿用各自原有错误文本，并在 keeper audit 中记录。

| 错误码 | 含义 |
|---|---|
| `SKILL_PATH_INVALID` | staging 路径不规范、越界或不在 `_incoming/<name>/` |
| `SKILL_RESOURCE_UNSAFE` | 符号链接、非普通文件或不安全父路径 |
| `SKILL_FILE_TYPE_UNSAFE` / `SKILL_FILE_TOO_LARGE` / `SKILL_TREE_TOO_LARGE` | 文件类型、单文件或整树限制不满足 |
| `SKILL_ROOT_MISSING` / `SKILL_NOT_FOUND` | 根文件或候选目录不存在 |
| `SKILL_MANIFEST_INVALID` | frontmatter/schema 必填字段或列表形状不合法 |
| `SKILL_NAME_INVALID` / `SKILL_NAME_MISMATCH` | name 格式非法或与目录名不一致 |
| `SKILL_CONTENT_ID_MISSING` / `SKILL_CONTENT_ID_INVALID` | 根身份缺失或请求值非法 |
| `SKILL_REVISION_INVALID` / `SKILL_STALE_REVISION` | revision 形状非法，或审核对象已经变化 |
| `SKILL_TARGET_EXISTS` | 正式目标已存在，拒绝默认覆盖 |
| `SKILL_PROMOTION_DENIED` | owner/proof/payload/admission 等晋升前置条件不满足 |
| `SKILL_ROLLBACK_INVALID` | 内部回滚 token 无效或已消费 |

## 已知限制

- 只通过 `save` 上传 UTF-8 文本 supporting files；二进制资源需要未来独立的受控文件导入接口。已在 git staging 中存在的普通文件仍会纳入整树大小、类型与 revision 检查。
- 拒绝晋升目前保留 `_incoming` 供修改，不自动删除候选；需要丢弃时应另走明确的治理/删除操作，避免把拒绝和不可恢复删除混为一谈。
- 本版不提供覆盖既有 canonical Skill 的晋升参数；正式 Skill 更新继续使用既有的完整文档 replace 流程。
