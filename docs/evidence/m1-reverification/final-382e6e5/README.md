# PR #27 当前产品候选证据：`382e6e5`

产品候选完整 SHA：`382e6e549e44bc0a87d01ff8819371d4b84c0888`（`fix/m2-closure-conditional`）。比较基线：PR #25 合并提交 `d813b84318aa554c65c162e533c079ba9ed16bdc`。本记录只描述当前候选及已留存的本机检查、隔离数据库记录和人工桌面观察，不代表三个关闭对象全部验收。

## 候选与环境

| 项           | 实测值                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| 最终产品候选 | `382e6e549e44bc0a87d01ff8819371d4b84c0888`，提交时间 2026-09-25 17:24:24（UTC+08）                             |
| 最近提交     | `1b6066d85e9ddb2bc972eb7526dd09867644ddf7`（17:22:27，队列编辑恢复序号）；`382e6e5`（17:24:24，Hook 行数调整） |
| 前序实现     | `3df66546d231ee80b53e854d4682e0197bbaea17`、`6ee088bd261d531b7a4b6b93859b25bdb4a0086b`                         |
| 运行环境     | macOS arm64；Node `v24.14.0`；pnpm `10.33.2`                                                                   |
| 隔离数据     | `/tmp/anyagent-opencode-go.aBEA0z/home`；AnyAgent Runtime DB 与 ZCode CLI DB 均为隔离数据                      |
| 视觉证据     | 本次未保存可交付截图或录屏。桌面步骤为 CUA 人工观察，数据库用于确认持久化身份和状态                            |

## 自动化和构建检查

以下为本机日志，不是 CI。检查按日志时间列出；`1b6066d`、`382e6e5` 相对 `6ee088b` 的改动限于 UI composer draft Hook 及其测试，不涉及 Runtime、ZCode Adapter 或原生 mapper。

| 检查                                                                           | 结果                            | 候选边界与记录                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir packages/anyagent-runtime test`                                    | **通过：63/63**                 | `/tmp/m2-pr1-final-runtime.log`，17:22:48；在 `1b6066d` 后、`382e6e5` 前运行。末两提交未改 Runtime                                                                                                                                                                                                                                   |
| `node --import tsx --test packages/services/test/anyagentZcodeAdapter.test.ts` | **通过：66/66**                 | `/tmp/m2-pr1-final-adapter.log`，17:22:48；Adapter 未被末两提交改动                                                                                                                                                                                                                                                                  |
| `pnpm --dir packages/ui test`                                                  | **通过：33/33**                 | `/tmp/m2-pr1-final-ui2.log`，17:26:10；在最终候选提交后完整运行                                                                                                                                                                                                                                                                      |
| `node --import tsx --test packages/services/test/anyAgentService.test.ts`      | **通过：10/10**                 | `/tmp/m2-pr1-final-service.log`，17:25:44                                                                                                                                                                                                                                                                                            |
| `node --import tsx --test` 加五个原生映射与停止恢复测试文件                    | **通过：28/28**                 | `/tmp/m2-pr1-final-native-mapper.log`，17:24:46；文件为 `native-turn-terminal-provenance.test.ts`、`session-mapper.test.ts`、`slash-commands.test.ts`、`stopped-turn-sqlite-resume.test.ts`、`stopped-turn-history.test.ts`。CLI 源码与另一工作树一致，忽略的构建产物由该工作树的固定源码构建后复制；本工作树没有独立重建 CLI bundle |
| `pnpm typecheck`                                                               | **通过**                        | `/tmp/m2-pr1-final-type-382.log`，17:28:12；包含 UI project references                                                                                                                                                                                                                                                               |
| `pnpm build:bootstrap`                                                         | **通过**                        | `/tmp/m2-pr1-final-bootstrap.log`，17:26:01；输出包含 bundle-size、动态导入和插件耗时警告                                                                                                                                                                                                                                            |
| `pnpm architecture:check`                                                      | **通过：0 violations**          | `/tmp/m2-pr1-final-arch-382.log`，最终候选后运行                                                                                                                                                                                                                                                                                     |
| `pnpm lint`                                                                    | **通过：0 errors、65 warnings** | `/tmp/m2-pr1-final-lint-382.log`，最终候选后运行；warning 不计为 error                                                                                                                                                                                                                                                               |
| 格式检查                                                                       | **通过：12 个文件**             | `/tmp/m2-pr1-final-fmt.log`，17:28:12；日志输出 `All matched files use the correct format`                                                                                                                                                                                                                                           |
| `bash docs/decisions/generate-index.sh --check`                                | **通过**                        | `/tmp/m2-pr1-final-adr-382.log`；先前误用不存在的 `scripts/check-adr-index.mjs`，已按仓库实际脚本重跑通过                                                                                                                                                                                                                            |

上表保留最终候选之前的运行边界；未因日志较新而把较早检查改称最终提交后重跑。各文件的运行时测试日志显示 Node SQLite ExperimentalWarning；测试汇总仍为上述退出结果。

## 桌面观察及数据库互证

隔离桌面位于 `/tmp/anyagent-opencode-go.aBEA0z`，使用真实 ZCode CLI。数据库为 `/tmp/anyagent-opencode-go.aBEA0z/home/anyagent-m1.sqlite`（AnyAgent Runtime）和 `/tmp/anyagent-opencode-go.aBEA0z/home/.zcode/cli/db/db.sqlite`（ZCode native）。只查询本次指定 Task、Input 与 M0 marker 的记录，未读取或写入凭据。

### M0 flag-off：最终候选后的基本烟测

2026-09-25 17:30（UTC+08），在 `382e6e5` 提交后，以隔离 home 通过 `/tmp/anyagent-opencode-go.aBEA0z/launch-m0-flag-off-rc.mjs` 启动 `AnyAgent M0 Flag Off RC`，`ANYAGENT_M1_WORKBENCH=0`。原 M0 Composer 提交 `Reply exactly M0_FLAGOFF_382_925 once.`，页面先显示运行中，约 5 秒后显示精确回复 `M0_FLAGOFF_382_925`。随后从原侧栏打开旧 M0 Task，能看到历史 `M0_NATIVE_7E3_OK_924`；再从原侧栏返回本次新建的 `Request for Specific Flag Response` Task，精确回复仍正确，原输入未被改写。

ZCode native DB 中 marker 所在 Task/Session 为 `sess_a23d5cf0-1aa5-467e-924a-cfd2500deabe`，Task 索引状态为 `completed`；输入 `queue_01a0d7e7-103d-75eb-a0e0-5f492f8511c1` 为 `sendText`、`startNow`、`promoted`，`promoted_message_id` 为 `msg_mugrg3g0_73ca05f2-1ca9-4093-b4e6-fef95f9e1d21`。native DB 的同一轮 assistant 消息为 `msg_mugrg3ga_7ee26b04-64cc-4a10-9136-8e606d20fefa`，其中存在目标 marker。此处是 M0 flag-off 的基本原生路径烟测，不扩展成完整 M0 Verified 验收；没有保存窗口截图。

### M1 自定义命令及队列编辑：较早 HMR 窗口

CUA 人工操作和双库记录发生在 2026-09-25 17:07–17:21（UTC+08），此时最终提交 `1b6066d`、`382e6e5` 尚未产生。测试窗口运行开发服务并发生 HMR；因此下列结果只记为 `6ee088b` 前序候选之后的桌面增量观察，不能归为最终 `382e6e5` 的 UI 通过，也没有留存截图。

AnyAgent Runtime DB 记录 Task `task_16c436a2-d6e4-4888-b6bf-8f7abe991e92`，产品 Session `session_4cbe51a7-0fbe-4712-8494-aebeae4c6e19`；ZCode native Session 为 `sess_685b994d-de69-4e71-aca9-b85ab2b1a9c7`。产品 Session 与 native Session 由 Runtime session 记录相连。

| 路径                        | 双库观察                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前工作区自定义 slash 命令 | 产品 Input `input_24ae352d-1334-461b-8970-f95880aed8cd` 状态 `completed`，无错误；事件包含 `input.accepted`、`execution.started`、`message.delta` 和 `execution.completed`。native 对应 `queue_input_24ae352d-1334-461b-8970-f95880aed8cd` 为 `promoted`。                                                                                            |
| 审批中的当前轮              | 产品 Input `input_17639e2f-355f-40d3-9dd6-a57a96795593` 完成；事件包含 `approval.requested`、`approval.response`、`tool.started`、`tool.completed` 及 `execution.completed`。native 对应 `queue_input_17639e2f-355f-40d3-9dd6-a57a96795593` 为 `promoted`。                                                                                           |
| 同 Task 队列编辑后提交      | 产品 Input `input_dbd7229c-fa4b-4347-8a37-29b780721053` 的 `requestedDelivery=queue`、状态 `completed`，native 对应 `queue_input_dbd7229c-fa4b-4347-8a37-29b780721053` 为 `promoted`、admitted/promoted sequence 均为 3。最终 Input 的附件 `queue-keep.txt`、`queue-add.txt` 状态为 `claimed`；`queue-remove.txt` 没有附到最终 Input，记录为 staged。 |

这确认了此前 HMR 窗口中的真实 CLI 自定义命令、审批响应及排队附件编辑的一次成功路径。最终 `382e6e5` 仍缺该 UI 路径在最终提交上的桌面重演与可交付视觉证据；本表不把双库持久化检查表述为当前候选的完整桌面验收。

## 三个关闭对象与剩余缺口

- **M0 Verified：** 当前候选新增一条 M0 flag-off 基本烟测，并通过 native DB 记录核对输入、消息和完成状态。完整 M0 回归仍未由该单场景覆盖。
- **Product Parity：** 当前候选自动化和较早 HMR 实际路径支持自定义 slash 与队列附件编辑的局部行为；最终提交缺 UI 重演证据。固定 CLI `/goal` 写入／恢复与运行中 compact 仍是接入缺口；#26 Required／Conditional／Deferred 分类未被本记录改变。
- **M1 Contract：** Runtime、Adapter 和 native mapper 自动化以及较早真实审批／工具流均只覆盖各自列明范围。独立授权撤销、真实断线恢复和副作用对账、失败后安全重试、终态待答控件等仍有技术或验证缺口。当前候选没有完整必测桌面组合路径及截图／录屏。

三个关闭对象继续分别判断；PR #27 的候选、自动化结果及本证据均不表示 Milestone #2 可关闭。
