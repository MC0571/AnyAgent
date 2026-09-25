# `5b2a386` 集成候选复验与后续发现

被测完整产品代码提交：`5b2a386152b85bf64ebc8d8f28afe35fe1a249e6`；比较基线 `origin/main` `8732e7117666352e6252df3992a2cf25a2ccf478`。系统 macOS arm64，Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、ZCode Adapter m1.2、固定真实 `zcode-cli/0.16.9@872ad960de7ec172591f7e1952f7849229f94521`。隔离 HOME `/tmp/anyagent-opencode-go.aBEA0z/home`；项目 `/tmp/anyagent-opencode-go.aBEA0z/m2-final-project`；M0 与 M1 分别使用隔离 Electron profile。真实 Provider 是已在隔离 App 内可用的 OpenCode Go；凭据未读取或写入证据。

## 最终候选本机检查

同一代码提交运行 `pnpm run verify:anyagent-core`：Contract 12/12、Runtime 82/82；Service／Adapter／failpoint 定向 `pnpm exec tsx --test packages/services/test/anyAgentService.test.ts packages/services/test/anyagentZcodeAdapter.test.ts packages/services/test/zcodeAdapterObservationFailpoint.test.ts`：90/90；`pnpm --filter @zcode/ui test`：实际挂载和 DOM 38/38；原生 mapper 3/3。`pnpm run typecheck`、`pnpm run lint`（0 error，65 条既有 warning）、`pnpm run architecture:check -- --changed`、`pnpm run build:bootstrap`、`bash docs/decisions/generate-index.sh --check` 均通过。差异与受改文件格式在证据提交前再次检查。原始本机输出 `/tmp/m2-5b2-{core,service,ui,type,lint,arch,native,adr,build}.log`。**无适用远端 CI；以上为本机可重复检查。**

## 正式桌面步骤与交叉核对

1. “分组”侧栏对 M1 Task `task_da128efe-ac23-4d02-82de-f72aee558285` 从菜单“标记为未读”；该行显示未读圆点，见[标记后窗口](grouped-unread-after-fix.jpg)。再次点该行后圆点消失，见[清除后窗口](grouped-unread-cleared.jpg)。mounted DOM 测试从初始无标记经 `setTaskUnread`、`onDidChange`、DOM 出现到点击携带 `expectedUnreadAt` 清除，再核对 DOM 消失。Runtime 是产品 sidebar metadata 唯一写入方，不向原生 CLI 派发管理动作。此项修复独立 reviewer 指出的 P2。
2. 同 Task 从正式 Composer 发送 `M2_RC_5B2_NAV_RUNNING_926` 长回答，在原执行仍 running 时进入[原自动化页](navigate-away-running.jpg)，随即从原侧栏回[原 Task](return-during-execution.jpg)；返回时“请求中断”仍在，原答复在原消息流继续增量。[同页完成态截图](return-after-complete.jpg)显示已工作时间与发送入口；截图可见区域未包含回答结尾。`END_NAV_5B2_926` 由同一 Input 的最后 `message.delta` 与 `execution.completed.result` 两条结构化事件核对，事件 ID 和时间见[双库核对](crosscheck.json)。产品 Input／Execution 归属原 Task／Session，原生 `session_input` 只有对应一条；33 个 `message.delta` 的首条早于 `execution.completed`。没有因导航重新发送输入。
3. 原顶部“新建任务”按钮与项目行“新建任务”按钮分别打开原 Composer，显式选 `Harness · fake`；各提交不同标记并在正式消息区显示 Fake 分片／Read 工具与结果。两条新 Task 的 Participant／Session／Input／Execution 均不同，见[顶部入口窗口](toolbar-new-fake-task.jpg)、[项目行入口窗口](project-button-new-fake-task.jpg)和[产品库存储核对](crosscheck.json)。先前 `3ca6872` 已独立验证 `⌘N` 新建真实 ZCode 与 Fake Task A→B→A；本候选的侧栏修复没有更改新建与执行路径。
4. 关闭 M1 实例后，以 `ANYAGENT_M1_WORKBENCH=0`、独立 Electron profile 在本提交启动 M0。原 Root／Composer 真实 CLI 输入 `M2_RC_5B2_M0_FLAG_OFF_926` 得到 `M0_5B2_OK_926`，见[M0 会话窗口](m0-flag-off.jpg)和[原生库存储](crosscheck.json)。原模型设置页可达、OpenCode Go 两个已有 Provider 显示“就绪”，见[设置窗口](m0-model-settings.jpg)；返回原任务和自动化页面后，重新从原侧栏进入该 Task，输入与回复仍归原会话。此项只证明当前 flag-off 基础回归，不扩大 M0 历史 Verified Baseline。

## 此候选发现的 Required parity 缺陷

在同一 `5b2a386` 产品提交、同一隔离 M1 App 中，先于 Fake Task A 的 Composer 输入未提交草稿 `DRAFT_A_UNSENT_5B2_926`，见[切换前](draft-a-before-switch.jpg)；从原侧栏打开已有 ZCode Task B，B 的 Composer 保持空白，见[Task B](task-b-after-draft-a.jpg)；再从原侧栏返回 A，Composer 也变为空白，见[返回 A](draft-a-return.jpg)。无须提交或重启即可复现。该候选未保持 Task A 的基本草稿，属于 #26 Required parity 功能缺陷；本目录其余通过项不意味着该候选已达到 PR 合并门槛。修复及复验应绑定后续产品提交，不能反向改写本次发现。

## 与上一代码提交的关系及证据边界

`3ca6872` 的[冷恢复、原任务侧栏菜单、真实 ZCode 同 Session 多轮／逐轮换模型、完成前流式、Fake A→B→A、M0 flag-off 截图与双库记录](../final-3ca6872/README.md)仍保留原产品提交归属。`3ca6872→5b2a386` 仅在 grouped Task 行渲染已有 `unreadAt` 标记及新增 mounted DOM 测试；没有修改上述执行、恢复、Composer、Adapter、原生派发路径。本候选重新运行了所有适用的自动化检查，另外当场复测 grouped 未读、执行中导航、多入口新建及 M0 flag-off，因此旧证据只能按此明确无影响分析用于当前候选，不能冒充 `5b2a386` 逐项重拍。

更早 `2b06484` 的真实附件／mention／编辑、审批允许与拒绝、结构化提问、Stop／unknown、Queue／compact、slash 与文件摘要仍以[其自身记录](../final-2b06484/README.md)为准；从该提交至当前只改 slash 当前 Task 目录和侧栏 UI／metadata，没有改这些业务控制与派发路径，且本候选 Contract／Runtime／Service／Adapter／UI 全套重新通过。独立 reviewer 已检查产品 diff，判断旧实机证据可在限定范围继承。没有真实物理 Host↔CLI stdio 断线桌面试验，不将 Adapter 观测中断、精确 stdio failpoint 扩大为已验证物理断线。其余异常与零派发事实继续由定向自动化和旧结构化证据支撑；视觉与组合交互以本目录和上一候选图片支撑。
