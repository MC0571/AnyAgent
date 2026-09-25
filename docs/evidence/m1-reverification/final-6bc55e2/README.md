# PR #25 集成候选 `6bc55e2`：交互派发资格与真实 CLI 增量复验

完整被测产品代码提交：`6bc55e2eeab63bc495a9c2c954feb15549969e52`；合并目标基线：`644120db21f654edbf40b4008df92294772a08cc`。本记录只证明本候选的增量场景；[三对象收口视图](../README.md#milestone-2-收口视图三个独立对象)保留原有 `f47e6b7` 事实，不自动将所有旧场景升级为此提交的最终 RC 结果。

## 修复与定向验证

审批和结构化提问答复原先在 Runtime 首次检查后可能等待 Adapter，期间请求过期，原生命令仍被送出。失败测试先出现 `Missing expected rejection`；现在 Runtime 在原生派发点复核 Task、Participant、Session、授权、当前能力、请求有效期和原 Execution，过期时保存 `expired` 并拒绝派发。Fake 和 ZCode Adapter 均在实际派发前执行此检查。运行时测试注入派发等待及时间前移，Adapter 测试断言零原生命令。

本机 macOS Darwin arm64、Node 24.14.0、pnpm 10.33.2；Electron 41.0.3，固定 `zcode-cli/0.16.9`，仓内 Adapter `m1.2`。以下命令均在上述产品提交运行，原始输出保存在 `/tmp/pr25-6bc-{contract,runtime,service,native,ui,type,clitype,lint,arch,adr,build}.log`。

| 命令                                                                                                                                                                                                                                                                                                                                                                           | 实际结果                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `pnpm --dir packages/anyagent-engine test`                                                                                                                                                                                                                                                                                                                                     | 9/9                                                  |
| `pnpm --dir packages/anyagent-runtime test`                                                                                                                                                                                                                                                                                                                                    | 58/58，含派发等待后过期的旧红新绿                    |
| `node --import tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/promptAttachmentTransferService.test.ts`                                                                                                                                                                                   | 76/76，含 ZCode Adapter 派发前零命令断言             |
| `node --import tsx --test apps/zcode-cli/packages/bootstrap/test/native-turn-terminal-provenance.test.ts apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts apps/zcode-cli/packages/bootstrap/test/slash-commands.test.ts apps/zcode-cli/packages/bootstrap/test/stopped-turn-sqlite-resume.test.ts apps/zcode-cli/packages/core/test/stopped-turn-history.test.ts` | 28/28                                                |
| `NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test`                                                                                                                                                                                                                                                                                                           | 33/33，既有 React `act` 告警仍存在                   |
| `pnpm typecheck`；`pnpm --dir apps/zcode-cli/packages/core typecheck`；`pnpm lint`；`pnpm architecture:check -- --changed`；`pnpm build:bootstrap`；`bash docs/decisions/generate-index.sh --check`                                                                                                                                                                            | 全部通过；lint 0 error／65 warning；架构 0 violation |

无适用远端 CI；以上为本地可复现检查。

## 正式桌面路径与双库存储

隔离数据、Electron 用户数据和测试项目均位于 `/tmp/anyagent-opencode-go.aBEA0z`。通过原 Root 的模型选择器选 `Harness · zcode · OpenCode Go (Responses)/gpt-5.6-luna`、`max`；原 Composer 用 Return 提交两个同 Task 真实 CLI 轮次。路径为正式 UI → Host／Runtime → ZCode Adapter → 既有 ZCode 服务 → 真实 CLI → 已配置真实模型服务。没有使用 Fake 或 loopback 冒充。

第一轮原生 `AskUserQuestion` 以原提问对话框询问能否创建隔离文件，选 Allow 后原 Write 权限对话框选仅本次允许。界面显示提问、工具、文件变化摘要和 `M2_6BC_WRITE_DONE`；实际 `m2-6bc-allow.txt` 内容为 `M2_6BC_ALLOW`。第二轮同原生 Session 请求另一次 Write，在原权限对话框选拒绝；界面报告 Write 被拒，`m2-6bc-deny.txt` 实际不存在。产品 Task／Participant／Session、两轮 Input／Execution、提问／审批归属和状态，与原生 Session、`session_input` 顺序、模型及工具状态在[同场景选取字段](question-approval-crosscheck.json)核对。桌面启动日志为 `/tmp/pr25-6bc-desktop.log`。

同一产品提交下关闭 M1 flag 重启隔离 App，窗口 URL 不含 `anyAgentServiceEnabled`，原选择器仅列 Provider；原 Composer 用 Return 提交 `M0_6BC_SMOKE`，真实 CLI `opencode-go-messages/qwen3.8-flash` 返回 `M0_6BC_OK`，原侧栏、自动化与 Provider 设置入口可达。[原生 Input／消息核对](m0-flag-off-crosscheck.json)。这只证明 M0 基础回归，不外推全部产品能力。

本轮 CUA 对原窗口的提问、审批和最终画面作了截图观察，图片随本任务工具记录显示，但当前工具未提供获准的仓库截图保存路径，因此这里没有可交付的截图文件。这个正向真实 CLI 场景也不能代替过期竞态的真实 CLI 重现；竞态由定向故障注入测试证明。`6bc55e2` 的最终全量视觉／导航及 #21 其余 RC 场景尚待复验；先前 `f47e6b7` 的 M0 对照保留其原提交归属。
