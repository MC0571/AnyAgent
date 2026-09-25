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

- 改造现有产品入口的业务交互路径、跨组件状态流或协议／持久化边界时，正式实现前在对应的现有 Issue／PR（没有则在本次实施说明中，并于创建 PR 时写入正文）留下三项可评审依据：已确认的可观察行为、必须保留及允许改变的既有体验，与本次验收；从当前代码核对的入口、状态所有者、调用／事件和存储路径及拟复用／替换处；最终集成版本上覆盖关键路径与失败／回归的证据计划及未覆盖范围。完成声明须回填对应候选的实际验证结果；集成改动使旧证据前提失效时，补验受影响路径。长期行为或结构变化仍分别维护在 `docs/specs/`、`docs/architecture/`；必要语义未确定或与已接受决定冲突时，只暂停依赖该决定的实现。依据足以评审本次改造即可继续；不触及上述边界的局部修改按现有规则直接实施和验证，不为每个 FR 新建文档。
- 当长期语义、产品边界、领域定义、行为契约或架构责任发生变化时，更新对应权威文档；根 `AGENTS.md` 只保留全仓稳定的工作规则。修改 `docs/decisions/` 时遵循其局部规则，不在此重复维护流程。
- 当需要运行检查时，从仓库现有文档、脚本、配置或 CI 读取真实命令；不编造技术栈、构建或测试命令。涉及行为验证时，按 [工程设计入口](docs/README.md) 的相关 `AC` 场景定位检查，`AC` 标识本身不证明已覆盖；只运行当前改动适用的现有检查，不要求每次全量运行。文档变更完成后回读文件，核对新增引用的文件和锚点存在，并运行适用的现有检查与 `git diff --check`；无产品实现时不把文档或脚本检查表述为产品验收通过。

### Engine 与本地 Runtime 接入

新增或修改 Engine、Adapter、本地 CLI/runtime 接入时，遵守以下长期边界；具体产品行为、Host 实现与当前阶段工作分别以 [Engine 契约](docs/specs/engine-adapter.md)、[运行与信任边界](docs/architecture/runtime-and-trust-boundaries.md) 和对应 Issue 为准。

- 先核对上述契约和 Issue 的 Current Scope、Non-goals、验收条件；不因 VISION 描述了长期能力就提前实施。
- 产品语义与实现细节分层：PATH、executable、argv、PID、stdio/JSONL/JSON-RPC、供应商 SDK 类型和私有配置留在 Host/Adapter；无经验证的公共需要，不加入 Engine Contract。
- 探测与启动须对应同一已核验安装；关键证据失效时重新核验或拒绝，不静默切换 executable、Engine、Provider 或权限模式。
- version、auth、model、capability、readiness 等辅助探测不拥有业务 Execution 生命周期；其失败或超时不得自行终止、重启或重绑仍有活动业务的 runtime。
- spawn、stdin 写入、transport ACK、进程退出和 Host kill 都不是原生接纳、业务终态或全部副作用停止的充分证据；证据不足时保持 unknown，并按既有对账语义处理。
- 不直接读取、复制或持久化供应商私有 credential 来补齐状态；认证、能力和恢复声明须有 Engine 正式接口或已验证运行证据。
- 区分原生缺失能力、Adapter 尚未接通和当前环境不可用；不得以自动批准、静默 fallback、伪造 resume 或改用其他 Engine 制造可用状态。
- Fake/fixture 只验证产品契约与故障语义；宣称真实 Engine 兼容须有固定版本的运行证据。
