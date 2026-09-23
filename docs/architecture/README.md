# 系统架构与公共边界

目的与范围：说明 Core + Reference App 的组织、依赖和替换边界；运行与安全细节见[运行与信任边界](runtime-and-trust-boundaries.md)，导入设计见 [ZCode 过渡](zcode-transition.md)。

设计状态：实现方案整体为 Proposed；遵循已接受的 [ADR 0001](../decisions/0001-domain-tools-are-optional-plugins.md)、[ADR 0002](../decisions/0002-engine-native-and-product-shared-tools-are-distinct.md) 和 [ADR 0003](../decisions/0003-cross-engine-collaboration-is-task-scoped.md)。D-101 已批准 M1 单参与者语义，见[领域模型](../domain/README.md#dom-02-关联基数与身份连续性proposed)；长期关系模型、超出 M1 的协作策略及具体实现方案仍为 Proposed。本次不扩大 ADR 0001–0003，也不批准新的技术选型。

实现与验证状态：历史核查快照为 2026-09-22 的 AnyAgent `intial` 分支、提交 `2b2c3b55ffcea62cd75e4bff9bafe9f55482523f`；该日期与提交保留。本轮定向复核于 2026-09-22、`intial` 分支 HEAD `73520d02bca217472c61fa62d5940eee37645a78` 完成，当时未发现应用源码、依赖声明、Runtime 或业务测试。M0 当前已导入上游过渡源码，来源与范围见 [ZC-04](zcode-transition.md#zc-04m0-整体-bootstrap-过渡基线)；以下 Core 模块和流程仍为待实现设计，不能以源码导入宣称已支持。

关联权威：[产品愿景](../../VISION.md)、[领域定义](../domain/README.md)、[状态归属](../domain/lifecycle-and-ownership.md)、[Engine 契约](../specs/engine-adapter.md)、[协作契约](../specs/cross-engine-collaboration.md)、[共享能力契约](../specs/shared-capabilities.md)。

## ARC-01：组织与依赖

首选一个模块化 Runtime Host 承载产品服务。模块边界由责任和公共契约确定，不预先拆成微服务。Desktop Shell 与 Host 在部署上允许分进程；Engine 是否为子进程、嵌入库或远程服务取决于实际接入，不由图示强制规定。

```mermaid
flowchart TD
  Ref[Reference App 组合与品牌] --> Shell[Desktop Shell]
  Other[第二个应用] --> API[Core 公共产品契约]
  Shell --> API
  Host[Runtime Host] --> Core[Core 产品服务与契约]
  API --> Core
  Core --> Port[Engine 与共享能力接入端口]
  Adapter[具体 Adapter] --> Port
  Adapter --> Engine[Engine 原生接口]
  Ref --> Host
```

图中箭头表示使用或依赖，Engine 事件经 Adapter 反向返回，不表示 Engine 依赖 Core。Host 作为组合入口装配实现；产品服务依赖端口，由 Adapter 实现端口，避免 Core 导入具体 Harness SDK。

| 边界 | 责任 | 不承担的责任 |
| --- | --- | --- |
| Core | 产品身份、Task/Workflow 协调、Session 身份及业务使用关联、授权范围、共享资产、持久化端口及公共行为契约 | Reference App 品牌、账户、计费、强制遥测或项目 SaaS |
| Reference App | 默认交互、产品配置、模块组合、品牌及发行选择 | 将私有 UI 状态变成 Adapter 必需输入 |
| Desktop Shell | 窗口、导航、用户观察和介入、系统集成；消费产品协议 | 在 UI 内作为任务状态唯一持有者或自行批准工具执行 |
| Runtime Host | 装配产品服务、连接执行宿主、校验业务接纳与执行关联、进程监督、持久化与恢复入口 | 接管 Engine 的 Agent Loop 或解释其未公开私有状态 |
| 产品服务 | 协调 Task/Workflow、Session 身份与业务使用关联、执行证据、资产与权限服务；可在同一 Host 内调用 | 每个名词必配一个进程、网络服务或数据库 |
| Adapter | 原生协议与行为映射、原生身份关联、能力探测、错误及事件来源标注 | 为缺失能力伪造恢复、取消确认或用量 |
| Engine | 自身 Loop、Model 使用、固定于该 Engine 的 Session、原生工具、上下文与私有状态 | 自动拥有产品共享资产的全部权限 |

Core 定义共享能力的公共边界；具体 Browser、Computer Use、知识检索、远程连接器、自动化执行器与云服务可以按应用需求选择装配。未装配时按能力契约显示不可用。Repo Wiki 保持可选领域插件，遵循 ADR 0001。Core、Adapter 和公共 UI 组件不得反向导入 Reference App 的品牌、账户或内部状态。

Session 是某个 Engine 的持续会话入口与原生状态关联，每个 Session 终身绑定一个 Engine。产品层保存 Session 身份、原生定位信息、业务使用关联和执行证据；Engine 继续持有原生上下文、记忆、工具状态及其他私有运行状态。Task 管理目标、参与者职责、授权、协作与验收；Task、参与者与 Session 之间记录本次业务使用关联，不把 Task 设为 Session 的永久生命周期所有者。

Agent Instance 本轮继续使用 Task 范围内的参与者身份；本轮不引入跨 Task 常驻 Agent 身份。未来若评估 Session 串行复用，也必须先建立目标 Task、参与者和授权的独立使用资格，不能由 Session 的历史使用者推导。

每个输入（包括尚未接纳的输入）及其 Execution 都必须保存 Task、参与者、Session、产品请求、原生执行和来源证据的可靠关联；历史归属不可由 Session 的当前使用者动态推导，也不能被后续业务使用覆盖。持久化需要能够表达这种不可变业务归属，但本轮不决定表结构。历史读取、会话恢复、业务接纳、任务收尾和资源释放是不同责任；恢复成功或 Session 连接可用都不授予业务执行资格。

M1 已批准单参与者路径：同一 Task 的多轮工作可以继续使用原 Session；新的独立 Task 使用新的参与者和 Session，拒绝将既有 Session 用于另一 Task；一个 Session 只允许一个明确参与者驱动，并按单 Session 单 Execution 串行策略处理。这里的“新 Task 新 Session”不表示每条用户消息都创建新 Task。多参与者／多 Session 协作及未来跨 Task 串行复用仍是 Proposed；其准入方向集中见 [DOM-05](../domain/README.md#dom-05-未来跨-task-串行复用条件proposed)，本文件不复制其条件，也不为此引入 Session Pool、分布式锁或新的中间件。

## ARC-02：三层契约

| 契约 | 消费方与生产方 | 稳定内容与变更边界 |
| --- | --- | --- |
| UI 产品协议 | Shell/其他应用 ↔ 产品服务 | 产品身份、命令接纳、投影、能力、审批及事件关联；不暴露 SDK 对象为必需字段 |
| Host 内部契约 | 产品服务 ↔ 持久化、资源执行器、Adapter | 资源授权上下文、产品与原生身份映射、执行确认及诊断；可随实现调整但不能改变对外语义 |
| Engine 原生协议 | Adapter ↔ Engine | 遵从相应版本真实接口；私有上下文、原生工具与状态仍归 Engine |

首版不决定 IPC 编码、数据库表或消息中间件。Host 内部优先直接模块调用；跨进程才引入传输映射。公共协议需要独立版本协商和兼容测试，但不承诺任何已有 ZCode、ACP、MCP 或 JSON-RPC 消息可直接替换它。协议形式相同不代表身份、生命周期、权限和错误语义相同。

接入自研 Engine 的验收以[最小 Adapter 契约](../specs/engine-adapter.md)为准；普通模型 API Adapter 只能承担模型调用。若以模型 API 构建 Engine，还需要明确拥有 Loop、工具执行、Session 和取消行为的 Harness 实现；不得将文本流包装为完整 Harness 后声称能力等价。

## ARC-03：确定性协调与可选智能参与者

Task/Workflow 服务持有依赖、显式消息、授权范围、预算和整合责任；依条件派发、限制重试、记录结果及传播取消属于确定性职责。可以按任务配置一个智能协调参与者，使用普通 Engine/Adapter 契约；其计划建议仍经过产品授权与任务规则校验。产品协调不依赖额外 LLM 主 Agent，也没有固定统领所有 Harness 的 Engine。

Task/Workflow 服务管理任务目标、参与者职责、授权、协作、验收及每次业务接纳；它不能依据 Session 是否打开、连接可用或恢复成功跳过这些检查。产品投影不是 Engine 原生会话库；恢复与 Handoff 的行为分别由规格规定，Handoff 仍创建新 Session。首版跨 Task 使用既有 Session 时必须拒绝并提供新 Session 加获准材料交接的路径，不能静默重绑历史记录。

领域关系和生命周期只在[领域文档](../domain/README.md#dom-02-关联基数与身份连续性proposed)与[状态模型](../domain/lifecycle-and-ownership.md#life-02-状态及完成判据proposed)定义。终态、取消或放弃协调后，Host 仍可进行获准的历史读取、对账及必要停止控制，但不能以归档释放原生会话或受未知执行影响的资源，也不能把迟到证据归给当前 UI 任务。

## ARC-04：本地与远程部署

```mermaid
flowchart LR
  UI[本地 Shell] --> H[产品 Runtime Host]
  H --> DB[产品持久化]
  H --> LE[本地 Engine 或执行器]
  H --> Link[受认证远程连接]
  Link --> RE[远程 Engine 或执行器]
  LE --> LW[本地资源]
  RE --> RW[远程资源]
```

首选产品协调和历史权威位于用户控制的 Host；远程执行器只拥有其运行事实和环境内资源，产品保存已确认事实及观测缺口。本地优先允许在线模型和远程 Engine。Workspace 位置、Engine 位置和浏览器位置分别声明；只有路径映射、传输、认证、工具、权限和恢复均验证过的组合才显示可用。

远程文件不是本地路径别名；资源引用必须带环境身份，复制产生新的来源记录。远程断线不改变执行结果。SSH、WSL、Docker 均为目标环境类别，当前没有一种已被 AnyAgent 实测支持。实际进程和恢复责任见 [RT-01](runtime-and-trust-boundaries.md#rt-01运行所有权与持久化方案)。

## ARC-05：候选接入层与退出

当前 ADR 未接受 TanStack AI、AG-UI 或 ZCode v4。没有核验其具体版本能力，因此不以它们推导契约或能力承诺。

| 候选 | 允许评估的位置 | 接受前验证 | 退出边界 |
| --- | --- | --- | --- |
| TanStack AI | 可评估具体 Engine Adapter 内部的完整 Harness 接入辅助或事件转换、独立模型调用实现，以及 UI 消费辅助；这些是评估范围，不是已支持能力 | 按固定版本源码及产品契约核实适用位置，对 Session、事件、审批、取消和扩展的映射是否保真；不将模型调用等同完整 Harness | 替换限制在具体 Adapter、转换或组装边界，不改变领域身份、状态归属和公共行为；不将其私有对象作为产品权威数据 |
| AG-UI | UI 产品协议外侧的可选转换层 | 版本与语义映射、丢失字段、重连和扩展表现 | 产品命令与事件仍独立；移除转换层不改变领域语义 |
| ZCode v4 | 过渡期局部兼容边界，尚未决定保留 | 核实来源、实际消息及绑定服务，逐项比对契约 | 见[过渡矩阵](zcode-transition.md#zc-02过渡矩阵)；不将 v4 固化为 Core 公共 API |

## 评审与未决问题

M1 的 Task／参与者／Session 使用关联、逐请求资格校验及单 Session 串行规则已由 D-101 批准，可据此实现单参与者路径。实现仍需选择并验证具体持久化与接口表达；这些工程细节不改变已批准语义。长期关系模型、多参与者协作及跨 Task Session 复用仍为 Proposed，未来准入条件见 [DOM-05](../domain/README.md#dom-05-未来跨-task-串行复用条件proposed)。

仍待维护者评审：Host 的独立进程生命周期、首个 Engine／Workspace 验证组合、公共协议兼容期限及候选接入层。具体 SDK、IPC、数据库或远程传输仍由实现方案决定；不为未来扩展预先引入会话池、分布式锁或中间件。ZCode 复用调查、Engine 原生能力验证和临时原型可以在完整未来关系定稿前继续，不因未决定未来能力而阻塞不依赖它们的开发。

验证方案：用无 Reference App 依赖的第二个最小客户端驱动同一 Core 契约；检查其创建任务、观察事件、审批和取消无需品牌账户。换一个 Adapter 或移除候选库后重放相同契约测试，产品身份与状态语义保持一致。这些是后续验收要求，本轮未执行应用验证。
