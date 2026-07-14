#!/usr/bin/env python3
# fixture：动态读取真实 _core.md，同时刻意带上 v1 锈迹段落供 getContext 出口过滤测试。
from pathlib import Path
import re

raw = Path('memory/about-owner/_core.md').read_text(encoding='utf-8')
core = re.sub(r'^---\n.*?\n---\n?', '', raw, count=1, flags=re.S).strip()
print(f"""# Substrate 常驻上下文（fixture）

## 关于主人（核心）

{core}

## 关于主人（记忆目录，需要细节时用 substrate-memory 读对应页）

- habits: 作息偏好
- communication-preferences: 沟通偏好

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
