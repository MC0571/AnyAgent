# 真实 CLI 运行中事件观测中断与原执行对账（2026-09-25）

被测产品代码提交：`92b66f2ff0246ab361d8febedfb2bff4ca0a173b`；基线 `origin/main`：`40ccce8fa723361406898b07d2068d225742e9dc`。这是 Milestone #2 的增量证据，不代替最终 RC 的完整桌面回归。正式路径为原 Root／侧栏／Composer → Host／Runtime → ZCode Adapter → 既有 ZCode Service → 真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521` → 隔离 App 中原已配置的 OpenCode Go (Anthropic) `qwen3.8-flash`；提交为 `build`／`xhigh`。macOS arm64、Electron 41.0.3、Node 24.14.0、pnpm 10.33.2；隔离数据与项目仅在 `/tmp/anyagent-opencode-go.aBEA0z/`，没有复制或提交凭据。

## 已完成的同一执行对账

- 从原新建任务入口创建 Harness Task `task_e858f272-39e9-475b-beac-d6acf6580a8e`；原产品 Session `session_0b3a524a-f49d-4288-a909-623bba52e5f8` 关联原生 Session `sess_94292a29-0a52-4e2b-9c71-8b16d182904b`。首轮真实 CLI 返回 `CLEAN_READY_925`。
- 第二轮由正式 Composer 发送 `M2_RUNNING_OBSERVATION_CLEAN_925`，只在正式审批 UI 选择“仅允许这一次”写入 `m2-observation-clean.txt`。开发态 failpoint 以隔离工作区、原生 Session、Input `input_cc13fa15-d23d-41fe-a7f9-fbcc6f2afd9b` 精确匹配，在 Write 工具结果后发布 `tool.completed` 与 `execution.unknown`，只结束该 Adapter Execution 的事件订阅。它不关闭 stdio、Host 或 CLI。定向 Adapter／配置测试检查 ACK 前缓存、三种身份不匹配、生产态禁用、一次性消费与迟到终态不误投影。
- 正式 UI 显示“执行结果未知；对账只查询原生状态，不会重发输入”及“对账原执行”；Composer 禁止新业务。首次点击对账时，原生 turn 仍为 running，产品 Input／Execution 仍 unknown；首次对账时间 `1790340001391`，原生终态直到 `1790340108650` 才产生，顺序可由[同场景双库存储、文件哈希与事件计数](running-observation-crosscheck.json)核对。
- 原生持久终态为同一 Input 的 `turn_complete/success`，终态证据 `native-turn-terminal:8dd72a0e-c861-4a07-a0ef-d7a01d49dd4a`。再次从 UI 对账后，**同一**产品 Execution `execution_658324ec-5242-49d4-b069-2d87e4d957fb` 成为 completed，`reconciledAt=1790340163326`，答案出现 `CLEAN_OBSERVATION_DONE_925`，并保留“遗漏的工具／文件事件未重建”警示。原生 Session 只有一条该 Input 的 `sendText` 和一条 completed Write part；实际文件 21 bytes、SHA-256 `cdb5f1485150797bc88474a453315d122683c5fd734bb7f82662f556bbac457e`。之后同 Task／Session 新 Input `input_4455b7ec-dab5-4bd3-843d-ffb442b1d86a` 返回 `CLEAN_AFTER_OK_925`，原文件未重写。

该场景验证**原生 CLI 仍运行时，单次 Adapter 事件观测中断所致 unknown 与两阶段原执行对账**。Host 与 CLI 的原始 stdio transport 全程未断；它不是物理 stdio 断线证明。窗口经 CUA 实际操作并观察了 unknown、对账入口、恢复答案和文件摘要，但本次没有保存可交付的窗口截图或录屏；视觉 RC 证据仍缺。结构化证据没有使用截图替代原生副作用核对。

## 未收口的后续待答工具场景

同候选的另一隔离 Task 在观测中断后，真实模型又完成 Bash 并开始 Edit；[该时点快照](running-observation-pending-tool.json)记录了产品仍 unknown、原生 Edit 为 running、原 Input 仅派发一次和文件实际状态。产品没有接收到新的待答工具请求，首次对账只能返回“原生 turn 行仍 running，无法证明其当前进程仍在执行”。这个快照**不是**成功的恢复或终态证据；后续授权／停止的可用处理入口仍在调查，不能将该场景算作通过，也不把模型后续调用工具误写成 CLI 不支持。

## 本候选本机检查

无适用远端 CI；以下为本机可复现检查。Contract 9/9、Runtime 73/73、Service／Adapter 84/84、UI 实际挂载／DOM 34/34、固定 CLI bootstrap 原生映射 5/5 均通过。`pnpm typecheck`、`pnpm lint`（0 error、65 条既有 warning）、`pnpm architecture:check -- --changed`、`pnpm build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、改动文件 `oxfmt --check` 与 `git diff --check` 通过；UI 测试仍有既有 React `act` 告警。上述检查和真实桌面场景均针对 `92b66f2ff0246ab361d8febedfb2bff4ca0a173b` 产品代码；证据提交稍后产生，若产品行为再改须补验受影响路径。
