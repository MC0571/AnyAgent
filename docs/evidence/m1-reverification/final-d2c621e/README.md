# `d2c621e` 草稿与产品入口最终候选复验

被测完整产品代码提交：`d2c621e09693660a89e1fd290357ce5fa804c3f4`；比较基线 `origin/main` `8732e7117666352e6252df3992a2cf25a2ccf478`。系统为 macOS arm64、Electron 41.0.3、Node 24.14.0、pnpm 10.33.2、ZCode Adapter m1.2、固定真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`。隔离 HOME `/tmp/anyagent-opencode-go.aBEA0z/home`、隔离项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-final-project`；使用隔离 App 既有可用 OpenCode Go 配置，未读取或导出凭据。

## 本提交检查

`pnpm run verify:anyagent-core`：Contract 12/12、Runtime 82/82；`pnpm exec tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/zcodeAdapterObservationFailpoint.test.ts`：90/90；`pnpm --filter @zcode/ui test`：mounted UI 38/38；`pnpm exec tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts`：3/3。`pnpm run typecheck`、`pnpm run lint`（0 error、65 条既有 warning）、`pnpm run architecture:check -- --changed`、`pnpm run build:bootstrap`、`bash docs/decisions/generate-index.sh --check` 均通过。本机原始输出 `/tmp/m2-d2-{core,service,ui,native,type,lint,arch,build,adr}.log`。**无适用远端 CI；以上为本机可重复检查。**

双 scope 草稿回归在本产品提交的 `EngineConversation` mounted DOM 测试中先红后绿：普通 Task 草稿 D 与撤回队列项 Q（含附件）并存，重挂载后应显示 D＋Q；旧代码实际只显示 D，`d2c621e` 的同步队列恢复优先级及初值更新后，等待一帧仍显示 D＋Q、两个 V4 scope 与附件票据均一致。该测试在 38/38 中；这是组件证据，不声称真实 CLI 桌面复现了双 scope 队列场景。

## 正式桌面与存储核对

1. M1 正式 Root 的顶部新建入口选择 `Harness · fake`，从原 Composer 按 Enter 提交 `M2_RC_D2_FAKE_A_R1_926`，得到 Fake round 1。于同 Task A 写未提交 `DRAFT_A_UNSENT_D2_926`，见[切换前](fake-a-draft-before-switch.jpg)；打开另一真实 ZCode Task B，B 没有该草稿，见[切换后](zcode-b-after-fake-draft.jpg)；返回 A 后草稿保持，见[返回 A](fake-a-draft-return.jpg)。再次按 Enter，Fake round 2、Composer 清空，见[第二轮](fake-a-second-round.jpg)。[产品库存储](crosscheck.json)显示两轮同 Task／Participant／Session，各有一条完成的 Input 与 Execution，第二轮草稿只派发一次。
2. 在同一 A 写未提交 `DRAFT_A_COLD_D2_926`，见[退出前](fake-a-before-cold-restart.jpg)。完全退出并重新启动隔离 App，从原侧栏打开 A，草稿与历史仍可读，但原生 Session unknown 且发送禁用，见[重启后](fake-a-after-cold-restart.jpg)。显式点击“恢复原会话”得到 `Fake Engine cannot reattach an unknown Session`，草稿仍保持，见[拒绝](fake-resume-rejected.jpg)。产品库中该草稿的 Input 数为 0；不把可读历史冒充执行资格，也不伪造 Fake 原生恢复。
3. 从原侧栏打开旧真实 ZCode Task `task_da128efe-ac23-4d02-82de-f72aee558285`，显式恢复原生 Session `sess_7add0d96-d4b1-44d1-a180-f0882a7f0e9a`，见[恢复窗口](zcode-old-session-restored.jpg)。在原 Composer 写 `M2_RC_D2_ZCODE_DRAFT_926`，切 A 再返回，草稿仍在，见[切换前](zcode-draft-before-switch.jpg)及[返回后](zcode-draft-return.jpg)；按 Enter 后同一 Session 得到真实回复 `ZCODE_D2_OK_926`，见[窗口](zcode-draft-submitted.jpg)。[双库核对](crosscheck.json)表明产品 Input／Execution 各一次，原生 `session_input` 恰好一次，原生 assistant text part 与 UI 一致；原生 user message 为 OpenCode Go Anthropic 的 `deepseek-v4.1-flash`、`max`，assistant message `planEnabled=true`，与 UI 计划模式一致。
4. 关闭 M1，以 `ANYAGENT_M1_WORKBENCH=0` 在隔离 Electron profile 启动同一提交的 M0。原 Composer 按 Enter 提交 `M2_RC_D2_M0_FLAG_OFF_926`，真实 CLI 回复 `M0_D2_OK_926`，见[原 Task 窗口](m0-flag-off.jpg)；打开[自动化页](m0-automation-nav.jpg)并通过原返回导航回[同一 Task](m0-return-task.jpg)。原生库记录此场景只有一个 promoted Input、对应一条 user message 和 assistant text part，见[双库核对](crosscheck.json)。这是当前代码 flag-off 基础回归，不扩大当年 M0 Verified 的验收范围。

截图均由 macOS 原生 App 的 CUA 操作即时保存，产品记录、原生记录和截图对应本节的同一组场景。早期 [`ee88aa9`](../final-ee88aa9/README.md)、[`5b2a386`](../final-5b2a386/README.md)、[`2b06484`](../final-2b06484/README.md) 证据保留各自完整产品提交归属；本提交并未逐条重跑附件／编辑、Tool／Approval、Stop／unknown、Queue／compact 和 slash 的旧 CLI 场景。对其未触及代码路径的继承见[当前三层矩阵](../README.md#当前-milestone-2-收口矩阵候选-d2c621e基线-8732e711)，不将旧截图称为本提交截图。
