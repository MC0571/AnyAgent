# PR #25 产品候选 `db192db` 原生窗口复验

完整产品代码提交：`db192db555f1ef950052f528595ad3d055562ef9`。本目录截图来自该提交启动的同一个隔离 macOS App；本记录是[唯一收口矩阵](../README.md#m0-单参与者能力收口矩阵)的证据，不能代替矩阵中仍为 D 的场景。更早候选的证据保留其原提交归属。

环境：macOS Darwin arm64；Node 24.14.0、pnpm 10.33.2、Electron 41.0.3；固定真实 `zcode-cli/0.16.9`，上游导入 `872ad960de7ec172591f7e1952f7849229f94521`，本分支 Adapter `m1.2`。复用隔离 App 已配置的 OpenCode Go (Responses) `gpt-5.6-luna` / `grok-4.6`，没有复制凭据。隔离目录 `/tmp/anyagent-opencode-go.aBEA0z/` 下的 `home`、`project` 和 Electron 数据与用户正式数据分离。M1 启动命令为该目录的隔离启动器调用仓库 `pnpm dev:desktop:prod`，设置 `ANYAGENT_M1_WORKBENCH=1`；正式路径为原 Root / Composer → Host RPC → Runtime → ZCode Adapter → `IZCodeAgentService` → 真实 CLI → 已配置模型。Fake、协议模拟和组件测试另列，均不冒充这条路径。产品 Runtime 与原生 SQLite 的选定字段只读交叉核查见[脱敏记录](runtime-native-crosscheck.json)；原始工具载荷和凭据未导出。

## 原 Task 两轮、重启恢复及后续轮次

原 Root 模型选择器按 Harness / Provider 聚合。Task `task_b41ef201-a190-4c18-9ff7-56a13e09768f`、Participant `participant_653a4202-8a5e-423d-a840-4e0489707372`、产品 Session `session_c0de0b3e-2eb6-4bb3-b450-4374cc2f6e88` 的首轮用 `gpt-5.6-luna` / `max` 读取隔离项目 README，回答 `GO_WORKSPACE_7F2C9A`、TypeScript 代码块和 `DB192_R1_END`；[首轮](native-r1-complete.png)。第二轮同 Harness、同 Provider 切为 `grok-4.6` / `xhigh`，回答 `DB192_R2_END`；[双轮和选择器](native-two-round-model-switch.png)。产品 Input `input_cc62d370-9b7c-4ecd-a949-07351797a81b`、`input_79ac1985-9fbc-4058-b2df-63dc2b0f88ca` 与 Execution `execution_5c6ed7e6-251b-4090-9dc3-340d8b7f6f07`、`execution_5c06234b-3ff5-4574-951a-9f839341c7b0` 均完成；原生 Session `sess_7630ba51-bd8e-46ea-af15-b23e9ac90203` 的 `session_input` 序号 0、1 各 promoted 一次，原生 user message model variant 为 max / xhigh，assistant model ID 与 UI 所选一致。

退出该隔离 App 进程并用同一提交、同一隔离数据重新启动。从原侧栏进入旧 Task 时，历史可读但原生 Session 为 unknown，Composer、反馈和分叉禁用；[恢复前](cold-history-unknown.png)。点击“恢复原会话”后，仍为上述产品 Task / Participant / Session 与同一原生 `sess_7630ba51-bd8e-46ea-af15-b23e9ac90203`，界面重新允许业务输入；[恢复后](cold-restored-ready.png)。恢复时 Runtime 按产品 Session 已存的原生命令来源查询真实 CLI Session，重新核对当前环境和授权；本轮没有把只读历史当作恢复证据。

恢复后原 Composer 输入 `/skill pr25-validation`，真实 CLI 调用 `Skill` 工具并返回 `PR25_SKILL_LOADED`；[运行中](restored-skill-running.png) · [完成](restored-skill-complete.png)。产品 Input `input_34d662ec-9f87-4af6-b7fe-5b26ffff3d60` / Execution `execution_a33958d4-036c-4307-a4b7-6c060394c1eb` 完成，原生输入序号 2 promoted，未创建假恢复 Session。对工具后的回答点赞再撤回，原生反馈归属同一回答；[点赞](restored-skill-feedback-liked.png)。配置变更、授权失效、业务终态和跨 Task 旧 Session 复用仍需独立验收，不能由这个正常恢复场景推出通过。

## 同进程停止、审批及文件撤销

原 Composer 提交长回答 `PR25_DB192_STOP`，正式回答已经显示前几条、尚可“请求中断”时抓取[中断前](native-stop-before-request.png)。点击后先显示请求送达的中间态，直到原生停止证据到达才显示[已停止](native-stop-confirmed.png)。产品 Input `input_25b72a2e-05d4-4757-b625-7c46ccf325c5` / Execution `execution_64cc2b7d-47fe-4d41-afc1-a82b472a58f6` 为 stopped；StopRequest `stop_9a5284a6-6d9b-4d1c-93a8-c6fb1f71e865` 为 confirmed / delivered，送达证据 `e7187819-736a-4e51-a760-88cfc40038e5` 与原生停止证据 `e18a1933-fca7-4d8f-bc5f-f0fd46acf013` 分开。进程断线、重启后的旧执行对账没有本候选窗口证据。

真实 `Write` 权限请求通过原 `PermissionDialog` 显示。拒绝 `pr25-db192-denied.txt` 的[请求](native-approval-deny-pending.png)和[结果](native-approval-denied.png)对应 Approval `approval_dd777f0e-bed2-4ea2-93e5-c8102b39dd5d`、requestEventId `event_577c3758-153c-43f2-9810-b1ab05e697af`，文件未创建。另一次允许写入 `pr25-db192-allowed.txt` 的[请求](native-approval-allow-pending.png)和[结果](native-approval-allowed.png)对应 Approval `approval_01a2cd44-ae16-452a-8793-dce6bf9919db`、requestEventId `event_adf5c9a0-cf57-4133-9a5b-e6ef4c1ac71c`；隔离文件内容为 `ALLOWED_MARKER_DB192`，UI 显示原文件摘要。迟到或过期答复尚未在窗口重演。

对该实际文件先打开[撤销预览](native-rewind-preview.png)：安全 1 / 不安全 0，取消后文件仍存在。重新打开并执行后，[摘要显示已撤销](native-rewind-applied.png)，隔离文件确实消失；产品 `file-rewind-operation file-rewind_bfe780d1-6441-4175-aaff-fd4aaefc096f` 为 applied，归于 `execution_e4c89905-819d-4e4f-a953-dc96a503c183`。结果未知时的防重复仅有较低层测试，本窗口未制造该故障。

## compact、分叉、提问与附件

原 Composer 输入 `/compact Keep the PR25_DB192_R1 workspace marker and the latest authorization outcome.`，产品 `compact-operation compact_a4508798-d197-4374-a110-e6d81b72c482` 从 accepted 到 completed，期间没有虚构业务 Input / Execution；[压缩处理中](native-compact-busy.png)。压缩后同一原生 Session 的下一轮回答 `DB192_COMPACT_CONTINUED GO_WORKSPACE_7F2C9A`。紧随其后的普通下一轮回答 `DB192_QUEUE_DONE`，它不是 busy 时排队的证据。

重启后在分叉子 Task 同一原生 Session 提交长回答 `PR25_DB192_RETRY_SOURCE`，正式回答已显示 `RETRY_BEGIN_DB192` 且仍执行时提交 `PR25_DB192_QUEUED`，界面展示[待发送项](native-queue-pending.png)。源轮完成并出现 `RETRY_END_DB192` 后，排队输入按序只执行一次，回答 `DB192_QUEUED_ONCE`；[推进完成](native-queue-completed.png)。产品源 Input `input_ac6b9317-5765-49cb-bc29-ec39e62845e1` 为 startNow，排队 Input `input_1cdd5b5b-1370-4741-b426-a3f8d35f2e07` 的 `requestedDelivery=queue`，两者均 completed。该候选 UI 的队列面板只提供移除，编辑、立即发送和排序仍为接入缺口，因此整行仍是 D。

对上述无文件副作用的队列轮点击原回答“重试”，新 Input `input_65375c14-89e2-40d3-b835-e1bfe5dbc3da` 的 `revisionOf.kind=retry` 指向源 Input `input_1cdd5b5b-1370-4741-b426-a3f8d35f2e07` 及 `execution_6925eb27-4319-4673-816c-034e2beb6c28`，源 Input 保持 completed，新轮回答相同 marker；[重试窗口](native-retry-pure-turn.png)。此场景不证明失败轮重试和已完成文件副作用防重复。

从原回答操作条分叉产生新的 Task `task_2a616b8e-c432-49ea-acd8-b4e1ce07fc02`、Participant `participant_e5fae7cb-9c9b-4bb3-8729-ee47c9efb04b`、产品 Session `session_7e486fab-afd2-42c5-92cc-fcc7d03e9243` 和原生 Session `sess_99d3f6c8-14b1-482f-8597-22aaf65864c1`。产品 Task 的 `forkedFrom` 指向源 Task、`input_0e601d15-d3b5-4d61-886b-c096e8205e0d` 和 `execution_56bf639d-d784-43a7-a15e-f773a7a389bc`；子 Task 有不同的授权 `authorization_db476a55-2b93-494a-a7f4-2399bd5c37d5`。源历史以只读方式呈现，[分叉窗口](native-fork-readonly-source.png)；子任务首轮 `DB192_FORK_CHILD_OK` 完成。

子 Task 要求真实模型先调用结构化提问工具。原消息流出现选择 A/B 的[提问](native-question-pending.png)，选 B 后同一执行继续回答 `DB192_QUESTION_DONE B`；[答复结果](native-question-answered.png)。产品 `user-input_8dfe150f-c887-4d0c-8608-a1a7ff245429` 的原始请求事件 `event_3f93e9c2-2dff-43c7-b2da-81dfd376c83f`、原生请求 `perm_0de5a209-54ef-405f-893d-c95f9b25a0a9`、Execution `execution_9c804a00-05c9-4208-b745-72048a3c1fdc` 和回答 B 均属上述子 Task / Session。迟到提问答复未复测。该回答点击踩再撤回，UI 分别显示已踩与未踩；[踩反馈](native-question-feedback-disliked.png)。

同一子 Task 通过原“添加上下文”菜单引用隔离文件 `pr25-db192-context.txt`，产品 Input `input_c4f0d819-abda-4a60-8b71-0d747fe10a21` 包含相对链接，真实 CLI `Read` 工具读到 `ATTACHMENT_MARKER_DB192`。之后通过原生文件选择器上传同文件，正式输入显示附件，模型回复同一 marker；[文件引用与附件](native-file-attachment-and-mention.png)。产品源 Input `input_aaaea1fb-60f2-49ca-b59e-099462a76bf8` 关联 `attachment_13ab205c-dbc9-4812-b4cb-a9cd1d91795a`。点击历史“编辑”时草稿保留附件；修订 `input_63e14b5a-7fce-4d3f-a530-115d56765263` 的 `revisionOf` 指向源 Input / Execution，仍引用原附件，模型再次读到原 marker。再编辑该修订，移除旧附件并通过原文件选择器加入 `pr25-db192-context-two.txt`；`input_ccb8faf5-16e7-4ba8-9609-013ff2742716` 的 `revisionOf` 指向上一修订，仅关联新的 `attachment_51e2b7a7-bb5e-40af-a455-3a2841f5a08f`，模型回复 `SECOND_ATTACHMENT_MARKER_DB192`；[替换后的消息与结果](native-attachment-edit-replace.png)。这些附件仅在隔离项目中创建，未上传到仓库。网页和共享会话导入不由这两项证明。

## Fake 与检查层级

同一代码候选下，从原新任务快捷键建 Fake A，再由工具栏建 Fake B。A 的 Task `task_1fd0f965-85ac-45b2-b981-798cfb86faeb` / Session `session_42aff60f-6c5f-4be3-bacf-baf6b5d60809` 有三轮 completed，B 的 Task `task_18bfc8a6-2d0b-4ea2-8bce-b80a916164df` / Session `session_cda4c470-903f-498e-b4b2-46ca06842e48` 有一轮 completed。侧栏 B→A、离开到自动化再返回 A 后三轮仍属 A；[A→B→A](fake-a-b-a.png) · [自动化返回](fake-return-from-automation.png)。Fake 轮数 fixture 跨 Task 计数，不能用显示序号替代产品归属。Fake 完成前慢分片未在本候选重演。

本提交本机执行：Engine Contract 9/9；Runtime 49/49；Service / Adapter / attachment 66/66；原生 mapper / terminal / slash 4/4；实际挂载与 DOM 29/29；`pnpm typecheck`；`pnpm lint`（0 error、65 warning）；`pnpm architecture:check -- --changed`（0 violation）；`pnpm build:bootstrap`；ADR 索引、修改文件 `oxfmt --check` 和 `git diff --check` 均通过。记录文件为本机 `/tmp/pr25-db192db-{contract,runtime,service,native,ui,typecheck,lint,arch,build,format}.log`，不是 CI；仓库没有适用的 `.github` 工作流。UI 测试仍有 React `act` 告警。代码复审由未参与实现的 subagent 相对 `origin/main` 审完整 PR，先前指出的冷恢复来源证明 P1、技能目录绕过 Runtime P2 已在本候选修复；复审未找到新的可复现代码阻塞，但明确未审桌面验收。

## M0 flag-off 双层对照

第一层沿用 ZC-04 固定 M0 导入基线和原 Root / Composer / 任务侧栏 / Provider 设置的交互预期。第二层在同一完整产品提交 `db192db555f1ef950052f528595ad3d055562ef9` 关闭 `ANYAGENT_M1_WORKBENCH`（`0`），用同一隔离项目及 OpenCode Go (Responses) `gpt-5.6-luna` 从原 Composer 提交 `M0_DB192`，真实模型返回 `M0_NATIVE_DB192_OK`；[原对话](m0-native.png)。启动 URL 无 `anyAgentServiceEnabled`；原模型选择器只有 Provider，未列 Harness；[选择器](m0-provider-selector.png)。自动化入口可达，原模型设置页只列 Provider 配置，OpenCode Go (Responses) 显示就绪；[设置](m0-settings.png)。原生 Session `sess_e776ad33-9d11-4b52-a075-01fe57d47a7d` 的 `session_input` 序号 0 promoted 到 `msg_mufy593e_840d6863-6b3c-4782-8b99-642374d4d712`；user message 模型为 `gpt-5.6-luna`、variant `max`。这只证明所列 M0 对话与导航没有被本候选破坏，不能推出全部 M0 能力未共同退化。

本候选的断线对账、迟到/过期答复、队列全操作、网页/共享上下文、全部 slash、模式/推理组合、所有新建入口、失败重试、失效资格及终态组合等仍须按矩阵补验。没有维护者确认的能力豁免；不能报告技术阻塞清零或请求合并。
