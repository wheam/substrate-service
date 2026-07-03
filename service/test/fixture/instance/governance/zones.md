# zones — 分区注册表（fixture）

```yaml
zones:
  - id: todo
    path: todo/
    purpose: 待办清单
    schema: todo-zone-v1
    maintainer_skill: substrate-todo
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: knowledge
    path: knowledge/
    purpose: 互链知识页
    schema: knowledge-zone-v1
    maintainer_skill: substrate-curator
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: collections
    path: collections/
    purpose: 通用收藏
    schema: collection-zone-v1
    maintainer_skill: substrate-collections
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: private
  - id: memory
    path: memory/about-owner/
    purpose: 跨 agent 共享的「关于主人」记忆
    schema: memory-zone-v1
    maintainer_skill: substrate-memory
    readers: [all]
    writers: [all]
    disposition: canonical
    privacy: sensitive
```
