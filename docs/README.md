# 工程设计入口

目的与范围：连接产品意图、领域定义、行为承诺、实现方案和决策依据，供后续实现与评审使用。本轮只建立文档基线，不实施业务、导入源码、安装 Runtime 或重构架构。

设计状态：新增设计均为 **Proposed（提案）**；已确认产品原则以 [README](../README.md)、[VISION](../VISION.md) 为准，已接受取舍以 [决策索引](decisions/index.md) 为准。实现与验证状态：截至 2026-09-22，无业务实现可验证；下列验收场景是未来检查要求，不能读成测试已通过。关联文档见阅读路径和追踪表；未决问题集中见文末。

## 阅读路径与权威位置

1. 阅读 [VISION](../VISION.md) 和 [既有决策](decisions/index.md)，确认目标及已经确定的约束。
2. 阅读 [领域概念](domain/README.md) 与 [生命周期和状态归属](domain/lifecycle-and-ownership.md)，确认对象含义、身份、关系和状态所有者。
3. 按工作主题阅读 [Engine 接入](specs/engine-adapter.md)、[跨 Engine 协作](specs/cross-engine-collaboration.md) 或 [共享能力](specs/shared-capabilities.md)，确认前置条件、外部行为、失败语义与验收要求。
4. 阅读 [架构总览](architecture/README.md)、[运行与信任边界](architecture/runtime-and-trust-boundaries.md) 和 [ZCode 过渡](architecture/zcode-transition.md)，评审组织方式、运行流程与实现路径。

| 位置 | 唯一职责 | 不在这里重复定义 |
| --- | --- | --- |
| `domain/` | 概念、身份、基数、生命周期、不变量、状态归属 | SDK、传输格式、数据库表 |
| `specs/` | 系统对外可观察的行为与失败契约 | 领域状态全集、实现选型 |
| `architecture/` | 模块、依赖、进程、持久化、恢复、信任和过渡方案 | 重写愿景、复制接口手册 |
| `decisions/` | 已接受的重要取舍及原因 | 候选方案、完整规格、动态进度 |

新概念与状态只在领域文档定义；规格引用其语义并规定行为，架构引用规格并解释实现责任。本文只维护导航与场景映射。规则使用 `DOM`、`LIFE`、`ENG`、`COL`、`CAP`、`ARC`、`RT`、`ZC` 标识；文内显式锚点支持稳定引用。测试实现可以引用这些标识及下列 `AC` 场景，但不能只凭标识宣称覆盖。

## 状态与证据的读法

| 标签 | 含义 | 不意味着 |
| --- | --- | --- |
| 产品原则已确认 | README、VISION 或本轮明确边界确定的方向 | 已有可运行功能 |
| Accepted | 决策目录记录的确定取舍 | 方案中的每个细节均获批准或经过实测 |
| Proposed | 本轮给出的首选可评审设计 | 已接受的架构决策、已经存在的 API |
| 代码已实现 | 当前仓库路径和符号支持该行为 | 测试通过或外部系统行为已验证 |
| 已验证 | 明确版本、环境、输入与观察结果支持限定结论 | 其他版本或所有 Engine × Workspace 组合均可用 |
| 待验证 | 缺少必要证据或尚未运行对应检查 | 不支持，也不意味着可以默认启用 |

未加独立状态标记的新增设计正文继承所在文档的 Proposed。规格中“必须、不得、应当”约束拟议实现的主体与行为，不改变上述状态。

<a id="baseline"></a>
## 仓库事实与资料缺口

核查日期：2026-09-22；起始分支：`intial`；AnyAgent 基线提交：`2b2c3b55ffcea62cd75e4bff9bafe9f55482523f`；起始 `git status --short` 为空。本节是本轮证据快照，不作为长期进度台账。

| 核查对象 | 观察结果及证据 |
| --- | --- |
| 当前受版本控制内容 | `git ls-tree -r HEAD`、`git ls-files` 仅列出根 AGENTS、README、VISION、LICENSE 和决策目录；工作区文件清单也未发现业务源码 |
| 实现、配置、依赖与测试 | 无应用清单、依赖锁文件、Engine Adapter、桌面/Host 实现或业务测试；现有可运行脚本只有 [ADR 索引生成与校验](decisions/generate-index.sh) 和 [其测试](decisions/test-generate-index.sh)，不能作为产品行为证据 |
| 架构文档 | 起始不存在根 `ARCHITECTURE.md`，也无 architecture/domain/specs 对应正文；因此新增这三类文档，无重复正文需要迁移 |
| 已接受决策 | [0001](decisions/0001-domain-tools-are-optional-plugins.md)、[0002](decisions/0002-engine-native-and-product-shared-tools-are-distinct.md)、[0003](decisions/0003-cross-engine-collaboration-is-task-scoped.md)；本轮不修改其状态、结论或修订历史 |
| 上游来源与源码导入 | README/VISION 声明基于 ZCode；当前树与可见 Git 历史没有导入记录。外部参考目录和官方固定提交的证据范围见 [过渡文档](architecture/zcode-transition.md)，不能视为 AnyAgent 已实现 |

存在两项需要显式处理的差异：

- **来源声明与实现进度不同。** README/VISION 的 ZCode 来源说明不构成源码已经导入的证据。本轮保留产品文档原意，在过渡文档中列出导入基线缺口；禁止据此描述 AnyAgent 已支持上游能力。
- **提案与 ADR 存储规则不同。** 本轮要求未批准方案保持 Proposed，而 [现有决策规则](decisions/AGENTS.md) 只接收 Accepted，并要求同主题原文件维护，不采用替代链。本轮无需调整任何已接受结论，因此不改规则、不新建 ADR，提案保留在其设计权威位置。若未来确需改变已接受结论，应先提出并评审替代建议，未获维护者批准不得改写当前决定；本轮不预先决定该情形的记录流程。

未发现 0001—0003 与本轮产品边界的实质冲突。参与者和 Session 基数是 0003 明确留白的细化提案，不能以“已接受跨 Engine 协作”为由当作已批准。

## 产品原则到验收的轻量追踪

下表的产品原则列指向原始来源，其余列只连接权威正文。`AC` 场景完整描述位于下一节。

| 产品原则 | 领域概念 | 行为规格 | 架构方案 | 相关 ADR | 验证场景 |
| --- | --- | --- | --- | --- | --- |
| [Engine 与 Model 分开](../VISION.md#engine-与-model-分开) | [Engine、Model、Adapter](domain/README.md) | [接入契约](specs/engine-adapter.md) | [公共扩展边界](architecture/README.md) | [0002](decisions/0002-engine-native-and-product-shared-tools-are-distinct.md) | AC-01、02、11 |
| [跨 Engine 协作](../VISION.md#跨-engine-协作) | [关联与状态](domain/lifecycle-and-ownership.md) | [协作契约](specs/cross-engine-collaboration.md) | [运行流程](architecture/runtime-and-trust-boundaries.md) | [0003](decisions/0003-cross-engine-collaboration-is-task-scoped.md) | AC-03—08 |
| [工作区与权限](../VISION.md#工作区与权限有真实边界) | [Workspace 与授权资产](domain/README.md) | [共享能力](specs/shared-capabilities.md) | [信任边界](architecture/runtime-and-trust-boundaries.md) | [0002](decisions/0002-engine-native-and-product-shared-tools-are-distinct.md)、[0003](decisions/0003-cross-engine-collaboration-is-task-scoped.md) | AC-04、06、07、09 |
| [双重产品定位](../VISION.md#产品定位)、[领域扩展](../VISION.md#领域工具与插件) | [工具和扩展归属](domain/README.md) | [公共能力与扩展](specs/shared-capabilities.md) | [Core 与 Reference App](architecture/README.md) | [0001](decisions/0001-domain-tools-are-optional-plugins.md)、[0002](decisions/0002-engine-native-and-product-shared-tools-are-distinct.md) | AC-09—11 |
| [独立产品与本地优先](../VISION.md#本地优先与产品独立) | [状态所有权](domain/lifecycle-and-ownership.md) | [能力和兼容边界](specs/engine-adapter.md) | [ZCode 过渡](architecture/zcode-transition.md) | 0001—0003 约束过渡；尚无第三方选型 ADR | AC-07、10、11 |

## 集成验收场景

以下检查的是设计必须能回答的问题，也是后续测试的输入。测试夹具可以使用确定性假 Engine/Adapter 和临时文件；真实 Engine 的不可替代边界另需固定版本实测。**本轮只做文档走查，未执行这些产品测试。**

| 标识 | 固定情境与检查方式 | 预期可观察结果的权威位置 |
| --- | --- | --- |
| <a id="AC-01"></a>AC-01 | 自研 Engine 只支持新建 Session、输入和终结事件；用契约夹具请求恢复、介入及用量 | [Engine 最小接入](specs/engine-adapter.md)：可用基本路径成立，缺失能力被明确标识，未报告的用量不补零 |
| <a id="AC-02"></a>AC-02 | 恢复不支持且运行中不能收消息；分别配置排队、下一轮及拒绝策略并尝试恢复 | [接入](specs/engine-adapter.md) 与 [协作](specs/cross-engine-collaboration.md)：历史可读与原生恢复分开，降级明确、可见，不冒充实时介入 |
| <a id="AC-03"></a>AC-03 | 同 Task 启动两个不同 Harness，用显式消息和产物连接分工 | [领域关系](domain/README.md) 与 [协作](specs/cross-engine-collaboration.md)：各 Session 保持自己的 Engine 归属，依赖与责任可追踪 |
| <a id="AC-04"></a>AC-04 | 两参与者同时申请写同文件或控制同标签；整合时外部又修改基线 | [共享能力](specs/shared-capabilities.md) 与 [协作](specs/cross-engine-collaboration.md)：可识别协调方、冲突及整合负责人，不静默覆盖或仅按最后完成者采纳 |
| <a id="AC-05"></a>AC-05 | 一个参与者失败，分别设置其产物为必需和可选，再尝试一次重试 | [协作](specs/cross-engine-collaboration.md)：依赖方等待/受阻与独立分支继续有明确策略，重试产生可追踪的新执行，不自动接受整体结果 |
| <a id="AC-06"></a>AC-06 | 取消并行任务；一执行确认停止，另一执行断线，已有文件变更 | [取消状态](domain/lifecycle-and-ownership.md) 与 [故障场景](architecture/runtime-and-trust-boundaries.md)：显示逐执行事实及未知项，不能报整个任务已停止或变更已撤销 |
| <a id="AC-07"></a>AC-07 | 在发送前、接纳后和副作用发生后分别断线；重连重复投递事件，再请求重试 | [事件/重连契约](specs/engine-adapter.md) 与 [持久化恢复](architecture/runtime-and-trust-boundaries.md)：去重不等于执行 exactly-once，结果未知先核对，副作用不明时不盲重放 |
| <a id="AC-08"></a>AC-08 | 从 Engine A Handoff 到 B；材料含授权文件、摘要和无权披露的原生状态 | [协作 Handoff](specs/cross-engine-collaboration.md)：新 Session、材料清单、来源和不可迁移项可见；超出授权材料不发送 |
| <a id="AC-09"></a>AC-09 | 只授予一个浏览器标签的操作权，再尝试使用其他标签、导出 cookie 或远程访问凭据 | [共享能力](specs/shared-capabilities.md) 与 [信任边界](architecture/runtime-and-trust-boundaries.md)：按范围拒绝或明确无法强制的边界，不复制全部登录状态 |
| <a id="AC-10"></a>AC-10 | 以第二个最小应用组装 Core、假 Adapter 和一个可选领域插件；不提供参考产品账户或云服务 | [架构边界](architecture/README.md)：公共契约可完成任务路径，Core 无 Reference App 内部导入，禁用 Repo Wiki 不影响基本接入 |
| <a id="AC-11"></a>AC-11 | 替换某候选协议库/接入库，保持同一组产品契约轨迹并禁用库专属扩展 | [架构](architecture/README.md) 与 [过渡边界](architecture/zcode-transition.md)：变更集中于适配和组装边界，公共状态不依赖供应商类型，扩展差异如实表达 |

## 评审待决与验证缺口

| 事项 | 首选提案和决定的权威位置 | 何时必须解决 |
| --- | --- | --- |
| Agent Instance / Session 关联及执行并发 | [领域模型](domain/README.md)、[生命周期](domain/lifecycle-and-ownership.md) | 首个持久身份和调度实现前评审基数及并发约束 |
| 最小接入能力、投递和终态证据 | [Engine 契约](specs/engine-adapter.md) | 首个 Adapter 按固定版本验证，不以 SDK 名称作能力依据 |
| 协作失败策略、预算和共享写入控制 | [协作](specs/cross-engine-collaboration.md)、[共享能力](specs/shared-capabilities.md) | 首个多参与者实现前选择可执行策略并验证冲突场景 |
| Host 生存期、持久化、远程恢复及隔离 | [运行边界](architecture/runtime-and-trust-boundaries.md) | 首个宿主实现前确认平台行为和无法强制的路径 |
| 上游固定基线与第三方采用范围 | [ZCode 过渡](architecture/zcode-transition.md)、[架构总览](architecture/README.md) | 任何导入或选型实施前核验来源、授权范围、兼容与退出条件 |

本轮未批准新的技术选型，未确定首发 Engine × Workspace 支持矩阵，也未执行真实 Runtime、浏览器或远程恢复验证。Automation/Jobs 的定时触发、完整 Computer Use 和知识索引/检索仍属于长期方向，本轮只设计它们需要遵守的共享边界，不编写其完整行为规格；不因此视为被排除的产品能力。

文档检查应使用现有 [索引校验](decisions/generate-index.sh)、相对链接与锚点检查、Markdown 基本结构检查及 `git diff --check`；不为这次文档工作安装依赖。没有业务实现时不得把脚本通过写成产品验收通过。
