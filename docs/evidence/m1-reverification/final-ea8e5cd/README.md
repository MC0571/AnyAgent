# 真实 CLI 终态帧断线与原执行对账（2026-09-25）

被测产品代码提交：`ea8e5cdd31a549a87934e5b7759eea9c428d82be`。本记录是 Milestone #2 的断线场景增量，不代替最终 RC 全量回归。[同一场景的脱敏产品／原生存储对账](disconnect-crosscheck.json)是身份、终态和文件副作用的结构化证据；没有把隔离数据目录中的原始数据库、凭据或完整协议帧提交进仓库。

## 环境和操作

- macOS arm64，Electron 41.0.3，Node 24.14.0，pnpm 10.33.2；ZCode Adapter `m1.2`，固定真实 CLI `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`，隔离 App 中已有的 OpenCode Go (Anthropic) / `qwen3.8-flash`，`build` 模式、`xhigh` 推理。凭据只留在隔离 App 的既有配置中。
- 隔离项目和数据均位于 `/tmp/anyagent-opencode-go.aBEA0z/`；通过该目录的启动器运行仓库 `pnpm dev:desktop:prod`，`ANYAGENT_M0=1`、`ANYAGENT_M1_WORKBENCH=1`。正式路径为原 Root／侧栏／Composer → Host／Runtime → ZCode Adapter → 既有 ZCode Service → 真实 CLI → 已配置真实模型。
- 从原侧栏打开已有 Harness Task `task_bbdc630b-0999-44f9-9e3f-b6b993d86b72`。重启后原生 Session 为 unknown，历史可读而 Composer 被阻断；点击“恢复原会话”，继续使用原产品 Session `session_38820f5a-f931-4ff5-8f27-03fe51fcc3b8` 和原生 Session `sess_4b6cc5d1-c734-4e80-88de-1c74d6165eed`。
- 开发态、隔离数据和精确 workspace／Session／Input ID 三重约束下，正式 UI 发送 `M2_FINAL_DISCONNECT_925`，在原生审批框选“仅允许这一次”，使真实 Write 工具创建 `m2-disconnect-final.txt`。隔离 failpoint 只吞掉该 Input 的 `turn.completed` 帧；配置在 `2026-09-25T11:54:15.499Z` 被消费，随后只结束其拥有的 CLI 子进程。该 failpoint 不写原始协议帧，默认路径及其他工作区不受影响；4/4 独立脚本测试覆盖精确匹配、生产环境无效、一次性消费和子进程边界。
- 正式 UI 在终态帧丢失后显示“发送状态暂时无法确认”“执行结果未知；对账只查询原生状态，不会重发输入”及“对账原执行”。原 UI 曾同时显示泛化的“处理失败”，本候选已把该文案限定于真正 `failed`；对应实际挂载 DOM 测试通过。在 UI 点击“对账原执行”，再从同一 Composer 发送 `M2_FINAL_AFTER_RECONCILE_925`，得到 `FINAL_AFTER_RECONCILE_OK_925`。

## 对账结果

| 事实     | 同一场景核对                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原轮次   | 产品 Input `input_c535504b-ffe2-4954-bf3e-ff150e160a04`、Execution `execution_d50ff9bc-7bcb-49c4-9f9e-72b4e3669cab`；丢帧后产品 SQLite 一度为 `unknown`，事件序列 48 是 `execution.unknown`，没有伪造完成或自动重发。                                                                                                                                                                           |
| 原生终态 | 原生 `session_entry` 的 `native-turn-terminal:e792a9ac-3196-46dd-bfd8-5eed1c377063` 精确归属原 Input，`eventType=turn_complete`、`resultType=success`。点击对账后原产品 Execution 成为 `completed`，记录 `reconciledAt=1790337294161`，并保留“对账前遗漏的工具／文件事件未重建”警示。                                                                                                           |
| 副作用   | 原生 `session_input` 只有一条原 Input 对应的 `queue_input_c535504b-ffe2-4954-bf3e-ff150e160a04`，状态 `promoted`；原生 `part` 只有一条匹配本文件的 completed Write。实际文件为 21 bytes、`FINAL_DISCONNECT_925\n`，SHA-256 `954233c536c401b512fd0aefd7b28475c1d6eeddbfdb9b21b28a069d8ec76d5d`。批准记录 `approval_c229d8ad-7dd9-4aa3-808e-6bf8fcdb913a` 绑定原 Execution，答复为 `allow_once`。 |
| 后续轮次 | Input `input_4a4afcbe-e6a3-460b-b01b-8a1a5644575f` 和 Execution `execution_b4f7853f-caac-4ddc-bef9-085132a3d025` 属于同一 Task／Participant／产品 Session，并由同一原生 Session 的另一条 `sendText` 完成；原文件保持上述哈希。                                                                                                                                                                  |

隔离窗口实际显示了断线未知提示、对账按钮、原工具／文件摘要和后续回答；本次没有保存可交付的窗口截图或录屏，因此这些视觉事实仅为操作观察，最终 RC 的视觉证据仍需补齐。自动化 DOM 证明未知状态不显示已失败文案，双 SQLite 与真实文件证明同一原执行对账及该副作用未重复。此场景丢失的是**原生持久终态已形成后的通知帧**，CLI 随即被隔离代理关闭；它不证明“原生执行仍在运行时连接断开并继续执行”的真实 CLI 路径。该路径保持待验证，不能据此将 #21 或 Milestone #2 的所有断线要求标为通过。

## 运行中 Renderer 重载增量

[同一真实 CLI 轮次的脱敏交叉核对](renderer-reload-crosscheck.json)对应同一被测产品提交 `ea8e5cdd31a549a87934e5b7759eea9c428d82be`、同一隔离 App／Task／Session。正式 Composer 发送 `M2_RUNNING_RELOAD_925`，仅允许一次 Write 创建 `m2-running-reload.txt`，要求模型随后继续较长回答；在该 Execution 仍为 `started` 且文件已存在时，按 `⌘R` 重载 Renderer。重载前记录 65 个 `message.delta`，重载后原 Execution 仍为 `started`、事件增至 143 个，最终同一 Execution 以 169 个 delta 和一次 `execution.completed` 结束；窗口实际显示最终标记 `RUNNING_RELOAD_DONE_925` 和一份文件摘要。原生持久记录只有一条该 Input 的 `sendText`、一条 completed Write part 和一条 success terminal；实际文件为 `RUNNING_RELOAD_925\n`，哈希见 JSON，未观察到自动重发。

此增量证明 **Renderer 与仍在运行的 Host 重连** 时，Host 继续接收真实 CLI 事件并将最终结果归入原 Execution。Host 与 CLI 的 stdio 连接在测试中始终有效，产品没有进入 unknown 或触发对账，因此它不替代“执行中观测中断后的 unknown／reconciliation”证据。本次窗口观察亦未保存可交付截图／录屏。

## 本候选本机检查

无适用远端 CI；以下均为本机可复现检查：`pnpm --dir packages/anyagent-engine test` 9/9、`pnpm --dir packages/anyagent-runtime test` 73/73、三个 Service／Adapter／附件测试文件 83/83、`NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test` 34/34、两个 bootstrap 原生映射测试文件 5/5、`node --test scripts/dev/zcode-stdio-terminal-drop.test.mjs` 4/4；`pnpm typecheck`、`pnpm lint`（0 error、65 条既有 warning）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、受改文件 `oxfmt --check` 与 `git diff --check` 均通过。UI 测试仍输出既有 React `act` 告警。
