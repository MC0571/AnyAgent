# M1 定向修复复验记录

本记录对应代码提交 `b5ae1e5b64af36e301f86374e7c6399027e87a1d`（基于 `origin/main` 的 `644120db21f654edbf40b4008df92294772a08cc`）。证据文件提交只增加本文、截图与脱敏的本地夹具日志，不改变被测代码。M1 Milestone 2 保持 **open**；这份记录供维护者复验，不代表验收通过。

## 环境与来源

| 项 | 实测值 |
| --- | --- |
| 系统 | macOS Darwin arm64，16 GB 内存 |
| Node / pnpm / Electron | 24.14.0 / 10.33.2 / 41.0.3 |
| 测试数据 | 隔离目录 `/tmp/anyagent-m1-layout.Ii5WZX/home`；未覆盖用户数据或凭据 |
| Engine / Adapter | M1 Fake；本仓库 ZCode Adapter `m1.1`；真实 `zcode-cli/0.16.9`，参考源码 `872ad960de7ec172591f7e1952f7849229f94521` |
| 模型提供者 | 本机 loopback `scripts/m1-loopback-provider.mjs`，`127.0.0.1:8767`；每轮不同标记、三个延迟分片和 Markdown 代码块；[脱敏请求记录](loopback-final.jsonl) |
| 桌面启动 | M0：`pnpm dev:desktop:prod`；M1：`ANYAGENT_M1_WORKBENCH=1 pnpm dev:desktop:prod`；两者使用同一代码候选与隔离数据目录 |

## 现有实现复用与状态归属

| 现有实现 | 本轮复用及局部适配 | 权威与新旧路径 |
| --- | --- | --- |
| `Root`、`WorkspaceSidebar`、`WorkspaceTimelineTasksSection`、`WorkspaceGroupedTasksSection`、`TaskListRowShell`、`WorkspaceHeader` | Engine Task 混排进原任务列表和原生行菜单；原标题、导航、返回路径保留；原生 Session ID 去重 | 产品 Task 由 M1 Runtime 持有；ZCode Session 仍由原服务持有。没有第二个正式任务列表 |
| `ChatPromptEditor`、`ConversationComposer`、`V4ComposerToolbar`、`ModelConfigSelect` | Engine 走原输入区及按 Harness / Provider 聚合的原模型选择器；当前 Session 不支持切换的选项置灰 | Harness 只在模型设置页提供入口，没有进入模型 Provider 注册、计费或认证流程 |
| 原 `Message` / `MessageResponse` Markdown、代码块、`ToolCallBlock` 及基础控件 | `EngineConversation` / `EngineConversationTimeline` 把已有 Engine 事件投影为原呈现组件需要的数据；正式回答在完成前显示 | 原始事件与 ID 仅在原生标题栏的可选诊断对话框。删除 `AnyAgentEngineWorkbench*` 平行聊天页面 |
| 原 Host `IAnyAgentService` RPC、`IZCodeAgentService`、`ProviderConfigRuntime`、数据目录设施 | 仅扩展已有服务装配和 ZCode Adapter 映射；从现有 Provider 配置运行时读取当前修订 | Host/Runtime 校验业务资格。M1 SQLite 持有产品 Task/Session/Execution、历史快照及事件；ZCode 原生 SQLite 持有原生 Session/输入。两者无共同可写权威状态，也未迁移用户数据 |
| 原 ZCode 协议映射 | 仅在 Adapter 边界传递 `text_start/end`，缺少原生 part ID 时从原生 message ID 与边界生成稳定块键 | ZCode 私有协议不进入公共 Core；缺少原生证据时明确降级 |

审批和用户输入以原消息区域的基础控件呈现。原 `PermissionDialog` / `ElicitationDialog` 依赖 ZCode 私有请求结构，不能在缺少同等原生字段时直接绑定；本轮没有为 Engine 伪造这些字段。其来源顺序未知时在已知 Execution 末尾标明不确定性。

## 实际检查

| 类型 | 命令或操作 | 结果 |
| --- | --- | --- |
| Contract / Runtime | `pnpm --dir packages/anyagent-engine test`；`pnpm --dir packages/anyagent-runtime test` | 9/9、15/15 通过 |
| Service / Adapter / 原生映射 | `node --import tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts`；`node --import tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts` | 12/12、1/1 通过；协议模拟与真实 CLI 分开记录 |
| 实际组件交互 | `NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test` | 11/11 通过，含挂载后 DOM、输入、多轮、流式、故障与控制、导航/选择器断言 |
| 静态与构建 | `pnpm typecheck`；`pnpm lint`；`pnpm architecture:check -- --changed`；`pnpm build:bootstrap` | 通过；lint 0 errors、66 个既有 warning；架构 0 violations |
| 文档与差异 | `bash docs/decisions/generate-index.sh --check`；`git diff --check` | 通过；全仓 `fmt:check` 有约 32 个基线文件未格式化，未为本轮绕过检查或重排无关文件 |
| 本地提供者 | `node scripts/m1-loopback-provider.mjs --smoke` | 通过；6 个延迟分片，日志不含消息正文/凭据 |

仓库未发现适合本轮直接运行的 `.github` CI 工作流；上述均为本机命令结果。

## 桌面验收矩阵

| 验收项 | 执行方式、结果与证据 |
| --- | --- |
| M0 原 Root、入口和基本对话 | **通过**：未开 M1 flag；原任务、自动化、模型设置可达，Engine/Harness 隐藏且无 M1 代理；原 Provider `m1-loopback` 的基础对话返回 `M1-R4-START` Markdown/代码。见 [Root](m0-root.png)、[对话](m0-conversation.png) |
| M1 Fake 正式 UI | **通过**：从原 Root/原生选择器建立 Task A，输入 `FINAL-FAKE-A-ROUND-ONE`、`FINAL-FAKE-A-ROUND-TWO`；同一产品 Session 内顺序显示 `Fake round 1`、`Fake round 2`，工具用原 `ToolCallBlock`。新 Task B 输入 `FINAL-FAKE-B-INDEPENDENT`，A→B→A、B 运行期间返回 A、离开自动化再返回 B 均保持归属。见 [完成前首段与工具](fake-before-complete.png)、[双轮](fake-two-round.png) |
| M1 真实 ZCode CLI + 本机模型提供者 | **通过**：在本代码提交的原生窗口中新建 Task/Session，两轮 `FINAL-REAL-CLI-ROUND-ONE...` 与 `FINAL-REAL-CLI-ROUND-TWO...` 经过 Adapter 和真实 CLI；答案分别为 `M1-R1-START`、`M1-R3-START`，同一产品 Session、不同 Input/Execution。见 [完成前首个分片](real-before-complete.png)、[双轮与代码块](real-two-round.png)、[提供者日志](loopback-final.jsonl) |
| 模型选择与设置 | **通过**：原选择器按 Harness / Provider 分组，当前 Session 的跨来源选择置灰；Harness 设置入口与原 Provider 配置均可返回。见 [选择器](harness-provider-picker.png)、[Harness 设置](harness-settings.png)、[Provider 设置](provider-settings.png) |
| Fake 故障与控制 | **组件与 Runtime 检查通过**：审批拒绝/过期、请求中断与停止确认、断线未知、能力变化和终态拒绝新业务在实际挂载组件及 Runtime 测试覆盖。未在原生窗口逐一人工触发这些故障 |
| 历史快照与当前能力 | **组件、Service、Runtime 检查通过**：覆盖可用→不可用、授权不足、未知、不支持、恢复及过期刷新不能覆盖新结果；历史快照保持原值，派发前仍由 Runtime 校验。原生窗口手动查看了 Harness 当前状态与刷新入口 |
| 未覆盖 | 真实 CLI 的原生工具、审批、用户输入、中断以及断线恢复；第二个真实 Engine、跨 Task Session 复用、多参与者路径不在 M1 范围 |

### 存储和时序核查

使用只读 `sqlite3` 查询隔离目录中的 `runtime_records` 与 ZCode 原生 `session_input`：

- Fake A：`task_13512f66-4ae4-4a25-8cb6-39e27a487664` / `session_ad0fa336-f65c-47a0-8383-b050f1e2890e`，两个不同 Input、Execution 均 completed。Fake B：`task_5d496555-a9a0-4a6f-99a5-4d5e7f5a344e` / `session_f5fc90fd-2396-4487-be1a-86e1710312e1`，参与者与 A 不同。
- 真实 CLI：`task_5b122993-3e6d-4d56-b57a-fb898400e72b` / 产品 `session_f1f2e7a1-e24e-4064-b95c-d649d1a6597c` / 原生 `sess_6139d681-ce8c-4f11-b9e2-81ab89c8f50d`。两个 Execution 为 `execution_719d4560-f090-48e8-9c4a-d3e99835325e` 与 `execution_c0ba6a0f-9502-40a9-9102-92e48a8e937c`；其各有 3 条相同消息/块身份的 `message.delta`，时间跨度分别约 3.2 秒，然后才 `execution.completed`。原生输入 `queue_bf25c845-2e5c-4937-ad31-a628492b58b0`、`queue_fad5e7a4-7c62-4045-8e1a-55d11418782b` 在同一原生 Session 中按 admitted/promoted 序号 0、1 被处理。
- 流式截图来自同一代码提交的补充原生窗口运行，均在页面仍显示“请求中断”时捕获；较早误拍的完成态画面未作为完成前证据。

## 后续确认

维护者需在修复 PR 上复验本记录，决定 #18–#21、#8/#10/#11 与 Milestone 2 是否满足关闭条件。本轮不自动合并、不自动关闭。
