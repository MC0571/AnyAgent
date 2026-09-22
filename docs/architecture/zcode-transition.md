# ZCode 过渡适配设计

目的与范围：记录可核实的来源边界、候选适配位置与迁移验证门槛；本轮不导入源码、不安装 Runtime、不执行迁移。

设计状态：Proposed。现有 ADR 未接受 ZCode v4、TanStack AI 或 AG-UI；本设计遵循 [ADR 0001](../decisions/0001-domain-tools-are-optional-plugins.md)、[ADR 0002](../decisions/0002-engine-native-and-product-shared-tools-are-distinct.md)和 [ADR 0003](../decisions/0003-cross-engine-collaboration-is-task-scoped.md)，不修改这些决定。

实现与验证状态：仅静态阅读与有限来源比对，未运行 ZCode 或 AnyAgent 应用；上游能力不等于 AnyAgent 已验证能力。

关联文档：[架构公共边界](README.md)、[运行与信任边界](runtime-and-trust-boundaries.md)、[Engine 契约](../specs/engine-adapter.md)、[共享能力契约](../specs/shared-capabilities.md)。

## ZC-01：来源与事实边界

<a id="ZC-01"></a>

核查日期：2026-09-22。

| 对象 | 已核实事实 | 不能推导的结论 |
| --- | --- | --- |
| AnyAgent 当前工作区 | `intial` 分支，HEAD `2b2c3b55ffcea62cd75e4bff9bafe9f55482523f`；跟踪文件清单只有文档、许可证、规则、ADR 索引与测试脚本 | README 的“基于 ZCode 二次开发”不能作为源码已经导入的证据 |
| 导入状态 | 未发现 ZCode 源码、依赖清单、导入记录或可复现上游导入基线 | 不能填写一个推测的“AnyAgent 当前 ZCode 版本” |
| 官方来源 | [zai-org/ZCode](https://github.com/zai-org/ZCode)；核查时官方 main 对应完整提交 `872ad960de7ec172591f7e1952f7849229f94521` | main 会移动；后续必须固定提交核查，不沿用分支名代表版本 |
| 工作区外参考目录 | 本地 `/Volumes/2T/dev/reference/ZCode` 存在，但无 `.git`；不是 AnyAgent 的跟踪目录 | 无法仅凭目录名确认整份副本来源或完整提交 |
| 有限逐字节比对 | 本地参考目录的 `package.json`、`packages/shared/src/zcode-protocol/index.ts`、`packages/desktop/src/main/index.ts` 与上述固定提交官方原文相同 | 三个文件一致不是整目录一致证明，也不是 AnyAgent 导入记录 |

固定版本依据：官方 [package.json](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/package.json) 声明版本 `3.14.0`、Node `>=24`、pnpm `10.33.2`。这些是上游声明，本轮不安装或验证这些环境。

已比对的官方 [main/index.ts](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/desktop/src/main/index.ts) 中有 `spawnHostProcess`、`disposeHostProcessAndWait`、`createTelemetryCore`、`createAppTelemetryRuntime` 引入，以及 `app.setPath("userData", runtimeUserDataPath)` 调用；只据此确认需要调查进程、遥测和数据路径的耦合，不据此宣称完成了其行为审计。

已比对的官方 [zcode-protocol/index.ts](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/packages/shared/src/zcode-protocol/index.ts) 注释和导出显示 legacy 与 v4 并存，并声明 `ZCODE_PROTOCOL_VERSION = 1`、`ZCODE_PROTOCOL_V4_WIRE_VERSION = 3`。v4 名称、wire 版本与产品版本不是同一件事；本轮没有验证 v4 的兼容性、完整生命周期或权限能力。

另外有限阅读了本地参考副本的 `packages/desktop/src/host/index.ts`（窗口 Host 与服务装配入口）、`packages/services/src/zcode-agent/zcodeStdioTransport.ts`（`ZCodeStdioTransport`）、`packages/shared/src/zcode-protocol-v4/index.ts`（导出入口）。这些文件未逐字节核对官方固定提交，只作为下一步调查位置，不作为已确认上游实现事实。

**差距及影响：** [README](../../README.md) 与 [VISION](../../VISION.md) 声明二次开发来源，但当前仓库尚未落入上游代码。保留产品声明，工程实现仍按未导入处理；任何“保留、包装、移除”都是未来导入方案，不能表述成现有代码改造已经完成。开始导入前需补足所选完整提交、来源、许可证与实际文件清单。

## ZC-02：过渡矩阵

<a id="ZC-02"></a>

首选按边界逐项验证和导入，不直接把上游内部模型定义成 AnyAgent Core。表中“回退”只涉及未来代码或配置路径；有持久化变更时必须保留备份和兼容读路径，不能假定旧程序能读取新数据。

| 范围与建议动作 | 前置依赖与待查位置 | 具体验证 | 回退边界 |
| --- | --- | --- | --- |
| UI：选择性保留可复用交互，包装为产品契约消费者 | 固定完整来源；查 Renderer 对 `@zcode/services`、原生 Session 和账户的依赖 | 接入假 Adapter，能力缺失、断线、拒绝审批能如实展示；第二个应用不导入 Reference App | 保留原 UI 在独立过渡入口，新入口失败可停用；不把 UI 私有数据持久化为 Core 权威 |
| 协议：将 legacy/v4 限定为兼容 Adapter 内部候选 | 逐项核对命令、事件、身份、流顺序和终态；从已比对协议入口继续追踪真实消费者 | 用录制且脱敏的输入/事件比对产品投影；未知字段或缺失能力不转换为成功；检查断线重放 | 替换兼容映射，保持产品身份与存储；不要求产品数据迁回 v4 schema |
| Host：调查后包装执行/资源管理，逐步分离产品协调 | 核实主进程与窗口 Host 的真实生命周期、服务注册、远程分支及持久化依赖 | 执行 [RT-02](runtime-and-trust-boundaries.md#RT-02) 的 UI 关闭、重启、进程退出场景；窗口生命周期不能丢失任务权威状态 | 新 Host 与导入 Host 不同时写同一权威存储；切换前停派发、对账并备份 |
| Agent：如采用则作为同级 ZCode Engine，保留自身 Loop | 核实启动参数、原生认证、运行依赖、Session 标识和公开停止接口；调查 `ZCodeStdioTransport` 的真实所有权范围 | 与自研假 Engine 使用同一最小契约套件；不能恢复/介入时显式降级；验证子进程停止范围 | 移除 ZCode Adapter 不删除产品历史；原生 Session 仅由兼容版本恢复 |
| 共享能力：选择性包装 Browser、File、Terminal、Git 等执行入口 | 调查身份、原生工具直达路径、远程资源与授权边界；按 ADR 0002 保持分属 | 两 Engine 竞争资源、授权到期和权限不足时不得静默越权；Browser 登录不整体复制 | 可逐项关闭能力并声明不可用；不降级到更高权限的原生路径 |
| 领域与扩展：保留公共能力，移出或不导入不需要的领域耦合 | 核实插件 API、Hooks 生命周期与 UI 注入；Repo Wiki 按 ADR 0001 可选 | 未安装领域插件时基本任务与共享资产仍可运行 | 卸载插件保留用户资产、记录格式版本；Core 不依赖插件私有类 |
| TanStack AI/AG-UI：继续候选评估，当前不引入 | 选定官方版本后核查能力及替换接口；范围见 [ARC-05](README.md#ARC-05) | 与不使用该库的契约路径比较，审批、错误与原生扩展无隐式丢失 | 仅替换转换或消费层，不改领域状态与产品持久化格式 |

## ZC-03：独立发行与数据处理

<a id="ZC-03"></a>

| 事项 | 导入前应形成的具体结果 | 验证与回退 |
| --- | --- | --- |
| 品牌与应用身份 | 枚举名称、图标、应用标识、协议处理器、签名和安装包标识；划分 Reference App 配置与 Core | 打包产物及桌面入口核对独立身份；配置变更可回退，但不复用上游安装身份覆盖用户应用 |
| 官方服务端点与账户/计费/分享 | 枚举请求源、启动时联网、认证流程与业务用途；基础功能移除强制项目 SaaS，可选服务显式配置 | 禁用这些服务进行离线产品启动与本地功能检查；恢复配置不得绕过用户授权 |
| 更新 | 查更新检查、下载、安装和强制更新分支；使用独立更新渠道或明确禁用 | 验证不向上游渠道查询/安装，不覆盖另一产品；失败时保留可启动版本与数据备份 |
| 遥测与诊断 | 根据 main 中的遥测入口追踪实际 sink、字段和开关；形成默认策略、脱敏与退出行为 | 在受控网络观察首次启动、失败和退出请求；禁用后不得仍发送隐式遥测；仅静态搜索不足以证明 |
| 数据目录与凭据 | 独立命名空间、schema 版本与迁移说明；来源未知的参考目录不作为用户数据输入 | 用副本验证迁移与回退，不直接移动或覆盖上游数据；凭据通过显式授权重新引用或认证 |
| 许可证与通知 | 保留 AnyAgent [LICENSE](../../LICENSE)，核对所选提交实际许可证、第三方 NOTICE 与资产授权，记录导入文件和来源 | 逐项对照导入清单与分发产物；许可或来源未核实的模块不进入分发。未核实上游许可，不能从本仓库 Apache-2.0 推定所有上游资产许可 |

移除某服务前先确认其他模块不借它完成必要初始化；隔离失败时标记组合不可用，不伪造认证成功。过渡过程中的数据外发、已有登录状态和历史迁移必须与应用授权匹配。

## 未决与批准门槛

需要维护者决定导入方式与范围、正式上游基线、是否暂留 v4、首个 Engine 与部署组合，以及独立发行配置。候选方案的代价分别是：整套导入能保留交互但继承耦合；按模块导入减少产品服务依赖但需要重新连接接口；仅参考重建保留最清楚边界但实现成本更高。当前首选按边界选择性导入和包装，最终选择依赖完整来源与许可核验、契约适配样例和故障验证，尚未批准。

后续迁移的最小评审包应包含固定提交与文件清单、许可证检查、协议字段/语义差异、能力声明、上述验证结果和回退演练记录。未经这些证据，不将“上游有此实现”提升为“AnyAgent 已支持”。
