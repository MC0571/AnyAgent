# `6b16453` 增量桌面记录（非最终候选）

被测产品提交：`6b164539f9ded6f276236d2c3ffb22cbc95da706`。macOS Darwin arm64，Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、仓内真实 zcode-cli 0.16.9、ZCode Adapter `m1.2`。隔离数据和项目位于 `/tmp/anyagent-opencode-go.aBEA0z`；正式 M1 App 由隔离启动器运行 `pnpm dev:desktop:prod`，使用已配置的 OpenCode Go (Responses) `grok-4.6`、`xhigh`。原始 App 日志在同一隔离目录 `app-6b16453-m1.log`；未使用正式用户数据。

从原侧栏打开原产品 Task `task_b41ef201-a190-4c18-9ff7-56a13e09768f`，历史可读但 Session 标 unknown；点击“恢复原会话”后，仍是产品 Session `session_c0de0b3e-2eb6-4bb3-b450-4374cc2f6e88`、原生 Session `sess_7630ba51-bd8e-46ea-af15-b23e9ac90203`。在原 Composer 输入 `/locale status`，界面提示中文环境及 `auto` 偏好，没有创建业务 Input。[窗口截图](native-cold-restore-locale.png)。随后经正式 UI → Host/Runtime → Adapter → 真实 CLI 发送 `PR25_6B16453_RESTORE`，同一原生 Session 新轮返回 `RESTORED_6B16453`。[后续轮次截图](native-restored-next-turn.png)、[只读产品和原生 SQLite 选取字段](runtime-native-crosscheck.json)。截图、日志与存储来自同次隔离运行。

同候选另启动了一个长回答源轮，但在提交第二轮前源轮已经完成；第二轮 `requestedDelivery=startNow`。这次操作**不能**作为 busy 队列测试证据。

本候选本机检查：Contract 9/9，Runtime 52/52，Service/Adapter/attachment 73/73，原生 mapper/terminal/slash 4/4，实际挂载 UI 29/29；`pnpm typecheck`、`pnpm lint`（0 error、65 warning）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、ADR 索引、修改文件格式、`git diff --check` 均通过。独立代码复审发现队列编辑回执与切换 Task 的草稿丢失竞态，故此提交不是最终技术候选。后续修复必须重新验证受影响路径；本页结果只归属本提交。
