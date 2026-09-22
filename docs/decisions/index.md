# AnyAgent 决策索引

> 本文件由 [决策记录规则](AGENTS.md) 规定并由 `generate-index.sh` 自动生成，请勿手工编辑。

| 决策 | 类型 | 状态 | 当前修订 | 决策简述 |
| --- | --- | --- | --- | --- |
| [0001：领域工具与系统核心保持分离](0001-domain-tools-are-optional-plugins.md) | Product | Accepted | 2026-09-22 | Repo Wiki 等面向具体领域的知识与工作方式按领域工具或可选插件提供，与系统核心保持分离。 |
| [0002：Engine 原生工具与产品共享工具保持分属](0002-engine-native-and-product-shared-tools-are-distinct.md) | Architecture | Accepted | 2026-09-22 | Engine 原生工具由 Engine 管理，产品共享工具由 AnyAgent 产品层管理，并通过 Adapter 连接两侧，同时保持归属与权限边界。 |
| [0003：跨 Engine 协作以 Task 与 Workflow 为边界](0003-cross-engine-collaboration-is-task-scoped.md) | Architecture | Accepted | 2026-09-22 | 每个 Session 绑定单一 Engine；Task 与 Workflow 协调跨 Engine 的 Agent Instance 与 Session，必要时通过显式 Handoff 创建新 Session。 |
