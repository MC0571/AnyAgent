# Goal 控制与冷恢复增量复验（2026-09-25）

本记录是 Milestone #2 的增量证据，归入[唯一收口台账](../README.md)。它不替代最终 main RC 的组合回归，也不表示 Milestone 已满足关闭条件。

## 候选与环境

- 完整产品代码候选：`7a4eaf68053bee5d22d75fe92a98e767968e72a1`。Goal 冷恢复三轮实测时的代码提交为 `7d766707c82b24d8dd105ba7262505160baea3c2`；其后 `7a4eaf6` 仅把**已确认终态、但正文事件未恢复**的提示与真正空回答分开。`7a4eaf6` 重启后复测了这条提示，未将较早三轮运行冒称为该提交的完整桌面重跑。
- 比较基线：`origin/main` 的 PR #27 合并提交 `5456321868fd57adee4504f1abdfc99ebe58a042`；Goal 分支还包含 PR #27 基线集成与 Goal 控制修复。
- 环境：macOS Darwin arm64；Node `24.14.0`、pnpm `10.33.2`、Electron `41.0.3`；固定真实 ZCode CLI `0.16.9`、ZCode Adapter `m1.2`。隔离目录 `/tmp/anyagent-opencode-go.aBEA0z`；测试项目仅为其中的 `project`。App 内既有 OpenCode Go (Anthropic)／`qwen3.8-flash` 配置可用，reasoning `xhigh`，没有在证据中保存凭据。
- 正式主路径：原 Root／侧栏／Composer → AnyAgent Host／Runtime → ZCode Adapter → 既有服务 → 真实 CLI → 已配置模型。启动器调用仓库 `pnpm dev:desktop:prod`，M1 flag 打开；不是 Fake 或 loopback。
- 无适用远端 CI；下述均为本机可复现检查。

## 原生 Goal 冷恢复场景

在 `7d766707c82b24d8dd105ba7262505160baea3c2` 上，新建 Harness · zcode Task，第一、二轮分别从原 Composer 发送 `/goal Reply exactly M2_GOAL_FIXED_R1_925 ...`、`/goal Reply exactly M2_GOAL_FIXED_R2_925 ...`，正式消息流分别显示对应唯一结果且发送按钮恢复。退出隔离 App，重新启动，从**原侧栏**进入原 Task。历史两轮可读，但 Session 显示未知并要求显式“恢复原会话”；点击后当前资格核验通过，再发送第三轮 `/goal Reply exactly M2_GOAL_FIXED_R3_COLD_925 ...`。第三轮正式消息流显示唯一 `M2_GOAL_FIXED_R3_COLD_925`，发送按钮恢复，无订阅解析错误。

[同一运行的产品／原生存储交叉核对](goal-cold-restore-crosscheck.json)记录了 Task、Participant、产品 Session、原生 Session、三组 Input／Execution 与三条原生 `sendGoalCommand`。原生每个 Goal Input 有控制轮与继续执行轮两个 `runtime/native_turn_terminal`，均为 success；产品每轮各只有一条 `input.accepted`、`execution.started`、`execution.completed`，没有重复结果。原生 Session ID 没有因冷恢复改变，第三轮没有被送到另一 Task。

对较早候选中**事件订阅已丢失**的旧 Task，`7d7667` 和最终 `7a4eaf6` 都只用原 Input ID 查询原生持久终态；Gateway 要求同一 Input 的 Goal 继续执行轮终态，以及较后发生、锚定该轮且验证通过的持久化记录。仅有控制轮 success 或仅有投影显示 completed 时保持 unknown。原执行对账成功后，产品明确说明丢失期间的工具／文件影响未重建、拒绝继续或自动重发。`7a4eaf6` 的正式 UI 提示为“原生终态已对账；回答正文未恢复”，没有把未恢复正文称为原本空回答。

本次 CUA 可访问性树观察到最终窗口，但没有可持久化的窗口截图文件；**视觉证据仍缺**。这些事实以同一隔离 App 的 UI 操作、双 SQLite 和本机测试交叉验证，不能算最终 RC 的完整视觉证据。

## 本机检查

| 命令                                                                                                                                                                                         | 结果                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pnpm --dir packages/anyagent-engine test`                                                                                                                                                   | 9/9                                                 |
| `pnpm --dir packages/anyagent-runtime test`                                                                                                                                                  | 63/63                                               |
| `node --import tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/promptAttachmentTransferService.test.ts` | 82/82                                               |
| `pnpm exec tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts apps/zcode-cli/packages/bootstrap/test/native-turn-terminal-provenance.test.ts`                          | 5/5；含冷恢复原生枚举和 Goal 控制轮／继续执行轮归属 |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test`                                                                                                                         | 33/33；`7a4eaf6` 的 UI 提示修改后复跑               |
| `pnpm typecheck`、`pnpm --dir apps/zcode-cli --filter @zcode/bootstrap typecheck`                                                                                                            | 通过                                                |
| `pnpm lint`、`pnpm architecture:check -- --changed`、`pnpm build:bootstrap`                                                                                                                  | 通过；lint 0 error、既有 warning 见本机输出         |
| `bash docs/decisions/generate-index.sh --check`、改动文件 `oxfmt --check`、`git diff --check`                                                                                                | 通过                                                |

原生命令、事件和存储的精确查询范围见交叉核对 JSON。`/goal` 的正式 UI 冷恢复路径已在此候选得到真实 CLI 增量证据；运行中 `/compact`、独立授权撤销、断线后副作用对账及最终 RC 视觉／组合回归仍单独收口。
