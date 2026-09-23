# Agent 规则

涉及已确定的长期产品、架构、数据或其他取舍时，先读 [决策索引](docs/decisions/index.md) 和 [决策规则](docs/decisions/AGENTS.md)，再按其中的主题与维护流程工作。

## 权威来源与范围

当任务涉及产品目标或工程设计时，先读 [README](README.md)、[VISION](VISION.md) 和 [工程设计入口](docs/README.md)，再按主题读取并引用唯一权威正文：

| 主题 | 权威来源 |
| --- | --- |
| 产品定位与长期愿景 | [README](README.md)、[VISION](VISION.md) |
| 概念、身份、状态与归属 | [`docs/domain/`](docs/domain/README.md)、[生命周期与归属](docs/domain/lifecycle-and-ownership.md) |
| 对外行为与失败语义 | [Engine 接入](docs/specs/engine-adapter.md)、[跨 Engine 协作](docs/specs/cross-engine-collaboration.md)、[共享能力](docs/specs/shared-capabilities.md) |
| 模块、运行、信任与迁移边界 | [`docs/architecture/`](docs/architecture/README.md)，包括 [ZCode 过渡](docs/architecture/zcode-transition.md) |
| 已接受的长期取舍 | [决策索引](docs/decisions/index.md) 及其记录 |

当任务涉及实现或验收时，区分长期目标（Target State）、本次确认范围（Current Scope）、Deferred/Non-goals 和实现事实；只实施本次确认范围。VISION、Proposed 设计和规格约束表达目标或待评审契约，Accepted 只表示取舍已确定，均不能单独证明能力已实现。ZCode 等参考来源按过渡文档核对，不能据此推断 AnyAgent 已导入或已验证其能力。只有当前代码、配置、测试、日志或其他可核对证据支持的行为才可描述为已实现或已验证；缺少证据时报告未验证。

## 变更与验证

- 当长期语义、产品边界、领域定义、行为契约或架构责任发生变化时，更新对应权威文档；根 `AGENTS.md` 只保留全仓稳定的工作规则。修改 `docs/decisions/` 时遵循其局部规则，不在此重复维护流程。
- 当需要运行检查时，从仓库现有文档、脚本、配置或 CI 读取真实命令；不编造技术栈、构建或测试命令。涉及行为验证时，按 [工程设计入口](docs/README.md) 的相关 `AC` 场景定位检查，`AC` 标识本身不证明已覆盖；只运行当前改动适用的现有检查，不要求每次全量运行。文档变更完成后回读文件，核对新增引用的文件和锚点存在，并运行适用的现有检查与 `git diff --check`；无产品实现时不把文档或脚本检查表述为产品验收通过。
