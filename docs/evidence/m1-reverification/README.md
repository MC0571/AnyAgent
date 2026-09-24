# M1 修复集成候选复验（2026-09-24）

产品代码候选：`7e3ff518cd1219935664d54f4626bc1f38be7024`，基于 `origin/main` 的 `644120db21f654edbf40b4008df92294772a08cc`。后续证据提交只增加本文和截图，不改变被测产品代码。Milestone #2 保持 open；本记录供 PR #25 的维护者复验，不表示 M1 已通过。

## 环境和证据归属

| 项               | 实测值                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| 系统             | macOS Darwin arm64，16 GB 内存                                                                                     |
| 运行时           | Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、真实 zcode-cli/0.16.9                                                 |
| Engine / Adapter | Fake Engine；本分支 ZCode Adapter `m1.1`；参考 ZCode 源码 `872ad960de7ec172591f7e1952f7849229f94521`               |
| 隔离数据         | `/tmp/anyagent-opencode-go.aBEA0z` 下的 home、项目、Electron 数据；未覆盖用户正式数据或凭据                        |
| 真实模型         | 用户在隔离 App 内配置 OpenCode Go (Responses) 的 `gpt-5.6-luna`、`grok-4.6`；凭据未写入仓库                        |
| 启动             | 隔离启动器运行仓库脚本 `pnpm dev:desktop:prod`；M1 设 `ANYAGENT_M1_WORKBENCH=1`，M0 设为 `0`；两者使用同一代码候选 |

较早的 loopback 基线及[脱敏请求日志](loopback-final.jsonl)保留。真实模型单项测试见[原生能力增量记录](native-parity-2026-09-24.md)。各截图文件名标注其实际代码候选，不拿早期运行代替最终受影响路径的复测。

## 原产品复用与权威状态

| 原实现                                                                                                                             | 本轮复用和必要适配                                                                                                                                 | 权威与新旧路径                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Root`、`WorkspaceSidebar`、`WorkspaceTimelineTasksSection`、`WorkspaceGroupedTasksSection`、`TaskListRowShell`、`WorkspaceHeader` | Engine 对话混排于原任务列表，仍用原 Root、导航、标题与侧栏；没有第二套正式任务列表                                                                 | M1 Runtime 持有产品 Task；ZCode 服务持有原生 Session，不合并身份                                                                                          |
| `ChatPromptEditor`、`ConversationComposer`、`ConfigSelect`、`ModelConfigSelect`                                                    | 正式输入使用原 Composer；选择器按 Harness / Provider 聚合，ZCode Harness 子菜单内可选同 Provider 模型，当前 Session 跨 Harness / Provider 选择置灰 | Harness 设置复用原模型设置页布局，不进入模型 Provider 注册、计费或认证流程                                                                                |
| `Message`、`MessageResponse`、Markdown / 代码块、`ToolCallBlock`、`PermissionDialog`、`ElicitationDialog`、回答操作条、原文件摘要  | Engine 事件由薄投影接入原呈现组件；真实 ZCode 审批和提问复用原组件；Fake 缺少原生结构时使用必要的通用答复控件；已答复审批不在正式消息流留内部卡片  | 原始事件、业务 ID、能力快照和结束原因只在可选诊断 Inspector；已删除独立 Workbench 聊天页面                                                                |
| `IAnyAgentService` Host RPC、`IZCodeAgentService`、`ProviderConfigRuntime`、原数据目录及 CLI 协议                                  | 扩展既有装配和 Adapter 映射；派发前仍由 Host / Runtime 复核资格                                                                                    | Runtime SQLite 持有产品 Task / Participant / Session / Input / Execution 和历史快照；ZCode SQLite 持有原生 Session 和输入；没有两个可写者维护同一权威记录 |

当前能力由当前环境、配置和探测结果计算；刷新失败为未知，较早异步结果不能覆盖新结果。Task 创建时的 Engine / Adapter / 配置 / 能力快照保持原值。条件恢复后重新检查资格，旧授权不会自动恢复。UI 禁用不能替代 Runtime 派发前校验。

## 最终代码候选的检查

| 命令                                                                                                                                                                                         | 结果                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm --dir packages/anyagent-engine test`                                                                                                                                                   | 9/9                                                                           |
| `pnpm --dir packages/anyagent-runtime test`                                                                                                                                                  | 41/41                                                                         |
| `node --import tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/promptAttachmentTransferService.test.ts` | 50/50；协议模拟与真实 CLI 分开记录                                            |
| `node --import tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts`                                                                                                     | 2/2                                                                           |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test`                                                                                                                         | 26/26，含实际挂载、操作及 DOM 断言；运行中有 React act / Tooltip 告警，未隐藏 |
| `pnpm typecheck`；`pnpm lint`；`pnpm architecture:check -- --changed`                                                                                                                        | 通过；lint 0 error、65 warning；架构 0 violation                              |
| `bash docs/decisions/generate-index.sh --check`；`git diff --check`                                                                                                                          | 通过                                                                          |
| `pnpm build:bootstrap`                                                                                                                                                                       | 通过，完整输出保存在隔离测试目录 `build-final-7e3ff51.log`                    |

仓库没有可对应本轮的 `.github` CI 工作流；以上是本机检查。全仓 `pnpm fmt:check` 的既有未格式化文件仍存在；本轮只核对修改文件，不重排无关文件。

## 桌面回归矩阵

| 验收项                                           | 候选、执行和结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 原 Root / Provider                            | **7e3ff51 通过**：关闭 M1 flag 启动，URL 没有 `anyAgentServiceEnabled`；选择器只列 Provider，原 Composer 用 OpenCode Go 返回 `M0_NATIVE_7E3_OK_924`；自动化及原模型设置可达，设置页无 Harness 入口。[原对话](m0-native-final-7e3ff51.png)、[模型设置](m0-settings-final-7e3ff51.png)                                                                                                                                                                                                                                                                                                                                                 |
| M1 Fake、A→B→A                                   | **7e3ff51 原生窗口通过**：Task A 三轮、独立 Task B 一轮；侧栏 B→A 后第三轮归 A，离开到自动化再返回 A 时三轮仍在。[A→B→A](fake-a-b-a-final-7e3ff51.png)、[返回自动化后](fake-return-from-automation-7e3ff51.png)。SQLite 核查 A 为 `task_e779a329-b347-4b4a-bfdc-f39d4bd70807` / `session_16fc2580-a385-4569-821e-4c38acd60bdd`，B 为不同 Task `task_b28e9a4e-56aa-4709-8b3c-c8fde6372f9f` / Session `session_9d34ceca-4b11-42e9-8257-591a2cda744c`。**ec22439 完成前可见**：5 秒间隔下回答首段与 Read 工具先于完成显示；[分片](fake-stream-final-ec22439.png)、[终态](fake-complete-final-ec22439.png)。7e3ff51 的相关挂载测试 26/26 |
| 真实 CLI：输入、审批、工具、文件                 | **7e3ff51 通过**：原入口新建 Task，`gpt-5.6-luna` 首轮经原 `PermissionDialog` 一次允许 Write，结果 `UI_WRITE_DONE_924`，原工具行和文件摘要可见；已答复审批卡片与过期顶部横幅不在正式流。[审批中](native-approval-pending-7e3ff51.png)、[完成后](native-approval-complete-7e3ff51.png)                                                                                                                                                                                                                                                                                                                                                |
| 真实 CLI：同 Session 多轮、模型、Markdown / 流式 | **7e3ff51 通过**：同一产品 Session 第二、三轮切换为 `grok-4.6`，顺序显示不同结果；第二轮 Markdown 标题和 TypeScript 代码块。[双轮](native-two-round-final-7e3ff51.png)。第三轮画面到第 14 条且仍可“请求中断”时抓到[完成前截图](native-stream-before-complete-7e3ff51.png)；最终出现 `END_R3_924`，没有重复答案。[三轮终态](native-three-round-final-7e3ff51.png)                                                                                                                                                                                                                                                                     |
| 原生文件撤销                                     | **c8bd3aa 真实 CLI 通过；7e3ff51 未重新点击撤销**：原文件摘要、预览安全 1 / 不安全 0，授权后原生文件消失，产品记录 applied，摘要显示“已撤销”。[预览](native-file-preview-c8bd3aa.png)、[撤销后](native-file-reverted-c8bd3aa.png)。7e3ff51 未改变撤销 Host / Runtime / Adapter 路径，只改审批完成后的 UI 投影                                                                                                                                                                                                                                                                                                                        |
| Fake 故障与当前能力                              | **7e3ff51 挂载组件与 Runtime / Service 测试通过；原生窗口未逐一注入**：审批拒绝 / 过期、中断请求与停止证据、断线未知、能力变化、授权不足、终态拒绝；历史快照未被当前刷新改写                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 原生能力边界                                     | 真实 CLI 的工具、权限、同 Provider 模型切换、附件引用、编辑、反馈、分叉、`/compact` 和文件摘要 / 撤销已在不同候选有单项证据，见[增量记录](native-parity-2026-09-24.md)。**未达到全量原生体验验收**：重启后的旧 M1 原生 Session 目前只可读，未证明可安全恢复继续；网页 / 共享上下文、真实 CLI 中断 / 断线恢复等仍未在最终候选端到端实测                                                                                                                                                                                                                                                                                               |

### 最终真实 CLI 身份和时序

隔离 Runtime SQLite 只读核查：Task `task_5bef8289-74d6-418b-9d14-0d4622b71d2f`，Participant `participant_ca07e969-3b0b-4897-b4fc-3984cf99a158`，产品 Session `session_03443a2a-d7b5-408f-a40b-5c6707b673b1`，原生 Session `sess_ef1bf738-769d-4425-8d05-41b33c5ab9d1`。三轮 Input 分别为 `input_5febe749-f095-4a72-b879-c94d4c4b34ae`、`input_f7cdc4bc-078c-4c14-9877-f51dc580142b`、`input_b8d8c4c4-ee1e-4083-8693-2530c716c6cc`；对应三个不同 Execution `execution_b06bb527-9efb-451f-ad8e-3669bb5ec173`、`execution_898eece3-a400-4d48-a4d1-e3120ee697e4`、`execution_7dadb512-0042-4bab-b6ca-f1c81ff6f1be`，均 completed。原生 `session_input` 在同一 Session 的 admitted / promoted 序号依次为 0、1、2。

第三轮有 43 条 `message.delta`，首条 `1790260234203`、末条 `1790260245768`，`execution.completed` 为 `1790260245818`；完成前截图和时序共同证明真实 CLI 增量进入正式回答区。第二轮 3 条、第一轮 4 条增量也早于各自完成事件。

### M0 单参与者能力对照

此表是 #26 的当前核查清单。M0 入口来自原 `SessionPane` / `ConversationComposer`、原服务和固定 CLI；“已映射”只表示列出的证据范围，不代表其它原生操作自动通过。

| M0 入口 / 能力                                       | Harness 路径及当前证据                                                                                                              | 待补                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 任务侧栏、对话标题、Composer、模型 / 模式 / 推理选择 | 原 `Root` / 任务列表、`ChatPromptEditor` / `ConfigSelect` / `ModelConfigSelect`；7e3ff51 原生窗口三轮、同 Provider 换模型及 M0 对照 | 冷恢复后的旧产品 Session 继续执行                 |
| 文本、排队、多轮、Markdown、代码块、流式、工具行     | `IAnyAgentService → Runtime → ZCode Adapter → IZCodeAgentService`；7e3ff51 真实 CLI 三轮；排队在 f0196fd 真实 CLI 单项通过          | 真实 CLI 断线后对账                               |
| 工具审批与结构化用户提问                             | 原 `PermissionDialog` / `ElicitationDialog`；7e3ff51 Write 审批实测，提问只有协议模拟和挂载组件测试                                 | 真实 CLI 提问及拒绝 / 过期的最终窗口实测          |
| 本地附件、工作区文件引用、网页 / 共享上下文          | 原添加上下文入口；本地附件和工作区文件引用在 d88035f 真实 CLI 单项通过                                                              | 网页 / 共享上下文仍未映射并实测，正式入口明确置灰 |
| Slash 命令、`/compact`、队列                         | 原 Composer 命令入口；`/compact` 在 bc714b0 真实 CLI 单项通过并作为独立维护操作记录；排队在 f0196fd 通过                            | 其余 M0 可见命令逐项核对                          |
| 反馈、分叉、编辑、重试                               | 原回答操作条及编辑器；反馈 / 分叉 / 编辑分别在 50d1bbd、bc714b0、993cbc5 真实 CLI 单项通过                                          | 重试尚无最终 CLI 证据                             |
| 中断、停止、文件摘要 / 撤销                          | 原控制和文件摘要；文件撤销在 c8bd3aa 真实 CLI 单项通过；中断请求 / 停止分离通过 Runtime 与挂载组件测试                              | 真实 CLI 中断及停止证据的最终窗口实测             |

## 维护者复验

PR #25 以 Refs 关联 #18–#21、#26 及 #8/#10/#11，不自动关闭。M1 是否达成由维护者在剩余原生恢复和未测能力补验后裁定；PR 提交、检查通过和本文均不等于最终验收。
