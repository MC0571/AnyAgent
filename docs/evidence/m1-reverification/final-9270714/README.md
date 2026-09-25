# 合并后 `main` 的真实 CLI 双轮与完成前流式复验

被测完整产品提交为 `9270714f827a4f4ddd01a0fe0051514dc32caabf`（PR #37 squash merge）；其产品代码树与合并前 `d2c621e09693660a89e1fd290357ce5fa804c3f4` 相同，二者之间仅变更 `docs/evidence/`。系统为 macOS arm64、Electron 41.0.3、Node 24.14.0、pnpm 10.33.2、ZCode Adapter m1.2、固定真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`。隔离 HOME `/tmp/anyagent-opencode-go.aBEA0z/home`、隔离项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-final-project`；使用该隔离 App 既有 OpenCode Go (Anthropic) 的 `qwen3.8-flash`、`xhigh`，未读取或导出凭据。

## 正式桌面步骤

1. 从原 Root 顶部“新建任务”选择 `Harness · zcode`，保持原 Composer 的变更前确认模式和模型设置。按 Enter 提交 `M2_MAIN_927_R1_926`，要求 50 条编号的 TypeScript 类型收窄建议，首尾分别为 `START_MAIN_927_R1` 与 `END_MAIN_927_R1`，不调用工具。
2. 在第一轮仍显示停止按钮、尚未出现 `END_MAIN_927_R1` 时，[完成前窗口](stream-before-completion.jpg)已经在原 Markdown 消息区逐步显示编号正文。产品库此轮有 95 条 `message.delta`，首条 `1790367085164`、末条 `1790367112488`，`execution.completed` 为 `1790367112526`；这同时证明事件在终态前进入原消息流。原生同一 assistant text part 只包含一次 START 和一次 END。
3. 第一轮完成并清空 Composer 后，在同一 Task／Session 按 Enter 提交 `M2_MAIN_927_R2_926`，要求只答 `SECOND_MAIN_927_OK_926`。正式[双轮完成窗口](real-two-rounds.jpg)按输入 1→回答 1→输入 2→回答 2 显示，第二轮得到目标正文并再次清空 Composer。

[产品／原生双库存储核对](crosscheck.json)将 Task `task_8cc97695-c4b8-467a-a369-1a59cc89605c`、Participant `participant_22453b74-80a9-4812-b421-219269e6d200`、产品 Session `session_a82386f8-d882-41d9-acf2-8f70e7795bd5` 与原生 Session `sess_8b33e4a0-10bb-4241-b064-0e332e2152ec` 分开记录。两轮各有唯一的 completed 产品 Input／Execution；原生 `session_input` 仅两条，admitted／promoted 序号为 0、1，各指向不同 user message 和对应 assistant message。两轮原生 user message 的 model／reasoning 均为 `qwen3.8-flash`／`xhigh`。没有用此前候选的历史轮次补足本候选多轮。

## 最终 main 代码树检查

双轮桌面复验后，在同一 `9270714` 产品树上运行：`pnpm run verify:anyagent-core`（Contract 12/12、Runtime 82/82）；`pnpm exec tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/zcodeAdapterObservationFailpoint.test.ts`（90/90）；`pnpm --filter @zcode/ui test`（mounted UI 38/38）；`pnpm exec tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts`（3/3）。`pnpm run typecheck`、`pnpm run lint`（65 条既有 warning、0 error）、`pnpm run architecture:check -- --changed`（0 violation）、`pnpm run build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、受改证据 `oxfmt --check` 及 `git diff --check` 均通过。本机原始输出在 `/tmp/m2-final-main-{core,service,ui,native,type,lint,arch,build,adr,format,diff}.log`。无适用远端 CI，不把本机结果称为 CI。

本次只补 #21 明确要求的同一最终候选真实 CLI 多轮与完成前流式证据；附件／审批／Stop／question／Queue 等旧场景仍按[当前三层矩阵](../README.md#当前-milestone-2-收口矩阵候选-d2c621e基线-8732e711)的代码影响与证据归属有限继承。本 PR 仅新增证据，没有改变 `9270714` 的产品代码；更早 `d2c621e` 的桌面组合见 [`final-d2c621e`](../final-d2c621e/README.md)。
