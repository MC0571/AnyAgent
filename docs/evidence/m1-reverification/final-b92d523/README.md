# PR #34：未知原执行的安全 Stop 增量（2026-09-25）

被测产品提交：`b92d523dc6a0233b59acdd28f106eae33b9a674c`；基线 `origin/main`：`40ccce8fa723361406898b07d2068d225742e9dc`。本记录是 PR #34 的增量验证，不代替 Milestone #2 最终 RC。正式路径为原 Root／项目侧栏／Composer → AnyAgent Host／Runtime → ZCode Adapter → 既有 ZCode Service → 真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521` → 隔离 App 已配置的 OpenCode Go (Anthropic) `qwen3.8-flash`。macOS arm64、Electron 41.0.3、Node 24.14.0、pnpm 10.33.2；输入使用 `build`／`xhigh`。隔离 profile 和项目位于 `/tmp/anyagent-opencode-go.aBEA0z/`，未复制或提交凭据。

## 真实 CLI／正式桌面步骤与结果

1. 完全退出旧候选 App，在 `b92d523` 上执行 `pnpm build:bootstrap`，再用隔离启动器运行仓库 `pnpm dev:desktop:prod`。从原项目侧栏新建 Task，原模型选择器选择 Harness zcode／OpenCode Go `qwen3.8-flash`。首轮完成后，原产品 Task `task_13b789e2-fa61-4f7f-80a9-6d7b2a69d442`、Participant `participant_de2fa9f0-fbdd-4e22-840b-190c956b7366`、Session `session_e5d556e2-8fb0-42ec-b363-485f27b41bcb` 对应原生 Session `sess_f62228fb-1f77-445d-91ed-99d38bb8da69`。首轮模型回复没有遵循要求的标记，故它只证明会话创建和真实请求完成，不充作模型内容正确性证据。
2. 同一正式 Composer 提交第二轮 `M2_PR34_UNKNOWN_STOP_925`，要求在隔离项目执行恰好一次 Write 后输出长回答。在正式权限框选择“仅允许这一次”。对原生 Session、Input `input_c2fa58b2-5249-408a-b79f-dfa1cc0306eb` 及隔离工作区写入一次性开发态 Adapter 观测中断 failpoint。它在工具结果后断开该 Execution 的事件观察，**不**断开 Host／CLI stdio。正式 UI 显示 unknown、对账入口及新增的“请求中断”；Composer 禁止新业务。
3. 原生第二轮已有 `runtime/native_turn_started` 而尚无 terminal 时，从该 unknown 面板点击“请求中断”。UI 先显示“中断请求已送达；这不表示已停止”，产品 StopRequest `stop_7899e403-0caa-45a4-bfb5-3db2d9007407` 的送达证据为原生命令 ACK `d50a13b1-eb77-462f-b6b7-bafe5e3fbfc4`。原生随后持久化同一 Input 的 `turn_complete/cancelled`，时间 `1790343632209`；StopRequest 创建时间 `1790343632189`。点击正式 UI“对账原执行”后，**同一** Execution `execution_21ee1040-3180-40b1-be33-1cf5b11c2af1` 才成为 `stopped`，StopRequest 为 `confirmed`，保留遗漏工具／文件事件未重建警示。
4. 原生该 Session 的业务 `sendText` 顺序为首轮、受控 Stop 轮、随后新轮，各只有一次；受控轮只有一个 completed Write part。实际文件 `m2-pr34-stop.txt` SHA-256 为 `0b8494e3833af8b4d00f5e09f8343cde043e71dae577cb3534d28ee3949da497`。同 Task／Session 的第三轮 `input_a559e47a-5340-4017-9f9a-a94a37c776c9` 在对账后完成，原生终态为 success。模型答复没有按要求输出标记，因此只将该轮记为同会话可继续及成功终态，不宣称标记内容通过。

[同场景产品／原生 SQLite、failpoint 与文件哈希核对](unknown-stop-crosscheck.json)包含完整产品提交、身份、提交配置、Stop request／delivery／terminal／reconcile 和各轮原生终态。数据记录与上述 UI 操作属于同一隔离运行。CUA 实际观察了 unknown、Stop 送达提示和 stopped 终态，但本机截图保存界面无法产生文件；**没有可交付窗口截图或录屏**。因此最终 RC 的视觉证据仍缺，结构化核对不冒充视觉证明。

## 本候选检查与边界

无适用远端 CI；以下为本机可复现检查，均针对 `b92d523`。`pnpm --dir packages/anyagent-engine test` 9/9；`pnpm --dir packages/anyagent-runtime test` 75/75；Service／Adapter／附件服务测试 87/87；`node --test scripts/dev/zcode-stdio-terminal-drop.test.mjs` 4/4；`NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir packages/ui test` 实际挂载／DOM 34/34；`pnpm typecheck`、`pnpm lint`（65 条既有 warning、0 error）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、14 个受改文件 `oxfmt --check` 和 `git diff --check` 通过。全仓 `pnpm fmt:check` 报 24 个未在此 PR 修改的文件，本 PR 的受改文件全部通过；没有为此重排全仓格式。UI 测试仍有既有 React `act(...)` 警告。

独立 reviewer `gpt-6-astra/low` 对完整产品 head `b92d523` 相对 `40ccce8` 审查，未发现 P1／P2／P3 代码 finding；它明确将真实桌面和最终视觉 RC 与代码结论分开。开发态 failpoint 的运行中观测中断仅证明 Adapter 事件观察失联；原始 stdio 全程在线，不能扩大解释为物理 CLI 断线。冷启动后缺失内存 Stop lease 的零派发、错配 ACK、跨 Task 和授权等待中撤销由 Runtime／Adapter 定向测试证明，不伪称真实 CLI 桌面实测。
