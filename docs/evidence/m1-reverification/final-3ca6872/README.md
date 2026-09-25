# `3ca6872` 最终 RC 增量复验

被测产品代码：`3ca6872e3a5464f2149e5c5c4c25eb35e8397589`。比较基线：`origin/main` `8732e7117666352e6252df3992a2cf25a2ccf478`。本目录场景执行期间的产品代码固定为 `3ca6872`；之后的 grouped 未读修复是 `5b2a386`，其复验另见[后一候选](../final-5b2a386/README.md)。系统为 macOS arm64；Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、ZCode Adapter m1.2、固定真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`。隔离 HOME `/tmp/anyagent-opencode-go.aBEA0z/home`，项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-final-project`，Electron profile 另隔离；沿用隔离 App 内已配置且可用的 OpenCode Go，没有读取或导出凭据。

## 本机检查

在该完整代码提交运行：Contract 12/12、Runtime 82/82、Service／Adapter／failpoint 90/90、UI 实际挂载与 DOM 38/38、原生 mapper 3/3；`pnpm run typecheck`、`pnpm run lint`（0 error、65 条既有 warning）、`pnpm run architecture:check -- --changed`、`pnpm run build:bootstrap`、`bash docs/decisions/generate-index.sh --check`、受改文件格式及 `git diff --check` 通过。命令原始输出保留于本机 `/tmp/m2-3ca-{core,service,ui,type,lint,arch,native,adr,build,format}.log`。无适用远端 CI；这些是本机结果。

## 正式桌面组合步骤

1. 冷启动 M1，从原任务侧栏打开置顶的旧 ZCode Task；在原侧栏“更多”菜单逐项重命名、标未读、清未读、归档、取消归档、取消置顶。旧 Task 起初只可读历史，原生 Session 未恢复前 Composer 不可派发；点击显式恢复后发送 `M2_RC_3CA_RESUME_R6_926`，得到 `RESUME_3CA_OK_926`。同一产品 Task／Participant／Session 及原生 Session 保持不变，产品和原生 Input 各一条。见 [恢复后的侧栏](sidebar-restored-task.jpg)、[原菜单](sidebar-menu-enabled.jpg)、[归档视图](sidebar-archived-task.jpg)及[双库存储核对](crosscheck.json)。旧原生 Session 创建于 `2b06484`，本候选验证的是冷恢复和随后新轮，不能冒充本候选首次建会话。
2. 原快捷键 `⌘N` 新建任务，从原模型选择器显式选 `Harness · zcode`，OpenCode Go (Anthropic) `qwen3.8-flash`／build／`xhigh`，发送 `M2_RC_3CA_NEW_TASK_R1_926`，收到 `NEW_TASK_3CA_OK_926`。在同一 Task 的 `Harness · zcode` 子菜单逐轮换为同 Provider 的 `deepseek-v4.1-flash`／`max`，打开计划模式，发送 `M2_RC_3CA_R2_MODEL_PLAN_926`；完成后有 24 条长回答、TypeScript 代码块和 `END_3CA_R2_926`，未重复。UI、产品 Input 配置、原生 `session_input` 和 user message 的 model／reasoning／plan 均对应原 Session，见[回答与选择器](model-plan-final.jpg)及[双库核对](crosscheck.json)。冷启动后显式恢复此 Task 的原生 Session，再发送第三轮 `M2_RC_3CA_STREAM_RETAKE_926`；窗口显示 `START_STREAM_RETAKE_926` 和“请求中断”时保存[完成前截图](streaming-before-complete.jpg)，原生完成后显示 `END_STREAM_RETAKE_926` 和“发送”，保存[完成后截图](streaming-after-complete.jpg)。同一 Input 有 24 个 `message.delta`，首个 `1790360316202` 早于 `execution.completed` `1790360322291`；本次图片确实来自未完成与完成两个状态，不再沿用误存的相同截图。
3. 原快捷键新建两个 Fake Task，经原侧栏 A→B→A，A 连续两轮、B 一轮；每轮在正式消息流显示 Fake 分片、Read 工具与结果。不同 Task 的 Participant／Session／Input／Execution 各自归属，见 [窗口](fake-a-b-a.jpg)和[产品库存储核对](crosscheck.json)。旧 Fake Task 冷重启后提示不能重新连接未知 Fake Session，本记录没有把旧 Fake 冷恢复记为通过；本次新建 Fake Task 的 A→B→A 已通过。
4. 关闭 M1 实例，在相同代码提交以 `ANYAGENT_M1_WORKBENCH=0` 启动独立 M0 Electron profile；原 Root／Task 侧栏和 Composer 从已配置 OpenCode Go 发 `M2_RC_3CA_M0_FLAG_OFF_926`，真实 CLI 返回 `M0_3CA_OK_926`。进入原“自动化”页再由侧栏返回原 Task，历史与输入可用。见 [M0 窗口](m0-flag-off.jpg)；原生 Session `sess_984fc9aa-3d58-4451-a927-67df394c1da2` 的一条 user 和一条 assistant message 对应一次 `session_input` `queue_01a0d9c5-985c-701f-a852-268b5906770f`。这只是当前 flag-off 回归，不改写 M0 当年 Verified Baseline。

## 证据边界

本增量的行为改动是 Task 侧栏元数据与其菜单，以及仅有 M1 置顶 Task 时置顶分区应存在；这些入口、冷恢复、真实新任务、同 Provider 换模、流式、Fake 隔离和 M0 flag-off 已在 `3ca6872` 复测。`2b06484` 同候选真实附件／mention／历史编辑、允许／拒绝审批、结构化提问、Stop／unknown 对账、队列／compact、`/goal`／`/init` 与文件摘要的证据保留在[早期记录](../final-2b06484/README.md)，但不称作本候选重跑。相关 Runtime／Adapter／消息行为自 `2b06484` 未更改且本候选自动化全套重新通过；最终 reviewer 仍须判断此继承是否足以关闭 #21。物理 Host↔CLI stdio 断线仍无真实桌面证据；已有精确 failpoint 与运行中观测中断证明其各自有限范围，不能扩大表述。
