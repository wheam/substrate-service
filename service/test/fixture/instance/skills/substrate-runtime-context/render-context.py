#!/usr/bin/env python3
# fixture：模拟实例 vendored 的 render-context.py（真实版见真实例私库）。
# 输出刻意带上 v1 时代的锈迹段落（路由表 / v1 房规 / 维护 skill 行 / substrate-memory 引用），
# 供 getContext 的「digest v2 化过滤」测试当靶子——真实例的 v1 渲染器同样会产出这些。
print("""# Substrate 常驻上下文（fixture）

## 关于主人（核心）

主人称呼 Alex。细节在分类页，按目录用 `substrate-memory` 现读。

## 关于主人（记忆目录，需要细节时用 substrate-memory 读对应页）

- habits: 作息偏好

## 库里有什么（各区速览）

> **Agent Packet**
> - zone: collections
> - 维护 skill: `substrate-collections`
> - canonical: 每个收藏的行式主表
> - 写前查: 主表里是否已有该条
> - 写后更新: ① 追加/改主表行；② 更新分片页

## 何时用哪个 skill（路由表）

- **substrate-collections** — 收藏维护。
- **substrate-memory** — 记忆维护。

## 房规（substrate 常驻接入）

- 路由：命中触发词时调用对应 skill（读它的 SKILL.md 并执行）。
- 写库后刷新：落库后跑 wire-context.py --apply。""")
