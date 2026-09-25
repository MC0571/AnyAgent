# `ee88aa9` 草稿修复候选复验与阻塞发现

被测完整产品代码提交：`ee88aa902c4c781accbd26d8f19b392a4e4824b6`；比较基线 `origin/main` `8732e7117666352e6252df3992a2cf25a2ccf478`。系统为 macOS arm64、Electron 41.0.3、Node 24.14.0、pnpm 10.33.2、ZCode Adapter m1.2、固定真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`。隔离 HOME `/tmp/anyagent-opencode-go.aBEA0z/home`、隔离项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-final-project`；真实模型使用隔离 App 既有可用 OpenCode Go，未读取或导出凭据。

## 本提交检查

`pnpm run verify:anyagent-core`：Contract 12/12、Runtime 82/82；`pnpm exec tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/zcodeAdapterObservationFailpoint.test.ts`：90/90；`pnpm --filter @zcode/ui test`：mounted UI 38/38；`pnpm exec tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts`：3/3。`pnpm run typecheck`、`pnpm run lint`（0 error、65 条既有 warning）、`pnpm run architecture:check -- --changed`、`pnpm run build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、受改文件 `oxfmt --check` 和 `git diff --check` 均通过。原始本机输出 `/tmp/m2-ee88-{core,service,ui,native,type,lint,arch,build,adr}.log`。**无适用远端 CI；以上为本机可重复检查。**

## 正式桌面与存储核对

1. 在 M1 正式 Root 通过顶部“新建任务”选择 `Harness · fake`，从原 Composer 按 Enter 提交 `M2_RC_EE88_FAKE_A_R1_926`，得到 Fake round 1。于该 Task A 输入 `DRAFT_A_UNSENT_EE88_926` 且不提交，见[切换前](draft-a-before-switch.jpg)。打开已有 ZCode Task B，B Composer 为空，见[Task B](task-b-after-draft-a.jpg)。返回 A，草稿原样保留，见[返回 A](draft-a-return.jpg)；按 Enter 后 A 出现 Fake round 2、Composer 清空，见[提交后](draft-a-submitted.jpg)。[产品库存储核对](crosscheck.json)表明两轮同 Task／Participant／Session，第二轮草稿恰好一条 Input 和一条 Execution，B 没收到该输入。
2. 在同一 A 再写未提交 `DRAFT_A_COLD_EE88_926`，见[退出前](draft-a-before-cold-restart.jpg)。退出并重启隔离 App 后从原侧栏打开 A，草稿仍显示，见[重启后](draft-a-after-cold-restart.jpg)；此时 Fake 原生 Session unknown，历史可读而发送禁用。显式点“恢复原会话”得到 `Fake Engine cannot reattach an unknown Session`，见[明确拒绝](draft-a-cold-resume-rejected.jpg)。草稿保留，未伪造恢复或自动派发。Fake 进程重启后不支持重挂接是 Fake 当前能力边界，不能用此结果证明真实 ZCode 恢复。
3. 从原侧栏打开旧真实 ZCode Task `task_da128efe-ac23-4d02-82de-f72aee558285`，显式恢复原 Session `sess_7add0d96-d4b1-44d1-a180-f0882a7f0e9a`，见[恢复窗口](zcode-old-session-restored.jpg)。在原 Composer 写 `M2_RC_EE88_ZCODE_DRAFT_926` 并保持未提交，见[切换前](zcode-draft-before-switch.jpg)；切 A 再返回，见[草稿仍在](zcode-draft-return.jpg)，按 Enter 后得到 `ZCODE_DRAFT_OK_EE88_926`，见[真实回复](zcode-draft-submitted.jpg)。[双库核对](crosscheck.json)表明原 Task／Participant／Session 不变，产品 Input／Execution 各一次，原生同 Session `session_input` 恰好一次，原生 assistant text part 为预期字符串；本轮 UI 和原生 user message 为 OpenCode Go Anthropic `deepseek-v4.1-flash`、`max`、计划模式。
4. 关闭 M1 后，以 `ANYAGENT_M1_WORKBENCH=0`、隔离 Electron profile 运行同一代码提交的 M0，原 Composer 按 Enter 提交 `M2_RC_EE88_M0_FLAG_OFF_926`，真实 CLI 回复 `M0_EE88_OK_926`，见[M0 窗口](m0-flag-off.jpg)及[原生库存储](crosscheck.json)。进入[原自动化页](m0-automation-nav.jpg)再从原侧栏回[原 Task](m0-return-task.jpg)，输入与答复保持原会话。此项是当前代码的 flag-off 基础回归，不扩大历史 M0 Verified Baseline。

## 后续独立审查发现的阻塞

独立 reviewer 对 `8732e71..ee88aa9` 完整产品 diff 发现一个可达 P2：当普通 Task 草稿 D 与撤回队列项 Q 的恢复稿并存时，重挂载可能由 `ChatPromptEditor` 延迟初始化将 D 覆盖 D＋Q，丢失 Q 文本而保留附件。现有 38/38 测试只覆盖单草稿，未覆盖双 scope 同时恢复。此提交不能作为 PR 合并或 Milestone 关闭候选；须在后续产品提交补复现测试、统一初始化优先级并复验。以上通过的单草稿、真实 CLI 和 M0 场景保持 `ee88aa9` 归属，不反向宣称该 P2 已在本提交解决。
