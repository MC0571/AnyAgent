# PR #35：真实 CLI 结构化提问空答复对账

被测产品完整提交：`a314e828e378cdc85bebe480aad2dfea14c7a7cf`；基线 `origin/main`：`cf4c2da3e6bde4a3b4b22de01b5a5b7e5c0a5190`。本记录是 PR 增量证据，尚非 Milestone #2 最终 RC。

## 真实桌面步骤与结果

在 macOS Darwin arm64、Node `24.14.0`、pnpm `10.33.2`、Electron `41.0.3`、固定 `zcode-cli/0.16.9` 上，以隔离数据目录 `/tmp/anyagent-opencode-go.aBEA0z/home` 和只含预置 README 的项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-question-project` 启动仓库 `pnpm dev:desktop:prod`。沿用隔离 App 中现有 OpenCode Go (Responses)／`gpt-5.6-luna` 配置，未读取、复制或记录凭据。M1 开关开启；原 Root、侧栏和 Composer 进入既有 Task，重启后先从侧栏显式恢复原生 Session。

正式 Composer 发送唯一标记 `M2_PR35_AUTO_QUESTION_R4_925`，请求模型调用 AskUserQuestion 提问 “Which verified marker should I use?” 并给出 Eta／Theta 两项。原对话窗口出现结构化提问；保持不作答。约五分钟后原生工具成功完成，窗口提问消失并显示 “No user answer was provided.”。同场景[产品／原生 SQLite 交叉核对](question-empty-crosscheck.json)记录同一 Task、Participant、产品／原生 Session、Input、Execution、原请求、原生 tool call 与原生结果事件。产品 UserInput 从 `pending` 变为 `forwarded`，答复是 `accept` 加空 `answers`，随后同一 Execution `completed`；各对象与映射答复事件均只有一条，没有再次派发原 Input。隔离项目仍仅有预置 README，无文件副作用。

固定 CLI 的工具结果是 `{success:true, content:"The user did not provide answers..."}`，不是先前协议夹具误用的 `{questions, answers:{}}`。`506c0fc` 候选的真实 R3 轮因此仍把产品请求记为 `rejected`；本候选 Adapter 改用实际结果形状，定向测试也改为同形状。早一轮 R1 曾因系统截图快捷键后的 Escape 被 App 当作用户拒绝，不能用作空答复证明。R2／R3 是修复前调查事实，不冒充 R4 通过。原生结果与约五分钟等待相符，但结果本身不足以单独认定具体计时器触发器。

## 本机检查与层级

本候选 Contract 9/9、Runtime 76/76、ZCode Adapter 78/78、原生映射 3/3、隔离 stdio failpoint 4/4、实际挂载 UI／DOM 34/34；`pnpm typecheck`、`pnpm lint`（65 条既有 warning、0 error）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、四个受改 TypeScript 文件 `oxfmt --check` 与 `git diff --check` 通过。受改范围以本机检查为准；无适用远端 CI，不能表述为 CI 通过。全仓格式检查存在 24 个未改文件的既有失败，本 PR 未全仓重排。

实际执行的测试命令为 `pnpm --dir packages/anyagent-engine test`、`pnpm --dir packages/anyagent-runtime test`、`pnpm exec tsx --test packages/services/test/anyagentZcodeAdapter.test.ts`、`pnpm exec tsx --test apps/zcode-cli/packages/bootstrap/test/session-mapper.test.ts`、`node --test scripts/dev/zcode-stdio-terminal-drop.test.mjs`、`pnpm --dir packages/ui test`。使用本机已安装 Node／pnpm 的绝对路径置于 `PATH` 前，以避开该隔离 worktree 的未受信任 mise 配置；没有改动项目依赖或跳过检查。产品事实从 `home/anyagent-m1.sqlite` 的 `runtime_records` 按本场景 Task／Execution 查询，原生事实从 `home/.zcode/cli/db/db.sqlite` 的 `session_input` 与 `part` 按同一原生 Session／toolCallId 查询；交叉核对的脱敏结果见 JSON。

独立 reviewer 在 `a314e82` 对完整 PR 差异审查无 P1／P2／P3；其审查没有把进行中的 R4 当成已通过，本段真实证据需随证据提交补审。桌面由 CUA 直接操作并观察，但本次没有保存可交付窗口截图／录屏；最终 RC 的视觉、导航和组合回归仍待单独完成。此记录不支持关闭 #21、#26 或 Milestone #2。
