# 反馈恢复修复后的最终候选复验

产品代码：`1c0b29248c30609b317f352720fe8b3c72db2711`，相对上一候选 `eecf9c686ec820e2a5a3c1c38f74eb4866ac5249` 仅改 `EngineConversation` 在产品 Session `unknown → active` 时重新读取原生反馈，以及相应的实际挂载测试。较早候选的[完整场景证据](../final-eecf9c6/README.md)保留原提交归属；本目录记录代码变化直接影响的反馈与恢复，以及本提交重跑的 Fake、真实 CLI 中断和 M0 路径。状态以[唯一收口矩阵](../README.md#m0-单参与者能力收口矩阵)为准。

环境仍为隔离 macOS Darwin arm64、Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、固定真实 zcode-cli 0.16.9、ZCode Adapter `m1.2`。复用隔离 App 的 OpenCode Go (Responses) 配置；测试数据与项目在 `/tmp/anyagent-opencode-go.aBEA0z/`，未复制凭据。M1 和 M0 均从本提交启动 `pnpm dev:desktop:prod`，分别设置 `ANYAGENT_M1_WORKBENCH=1` / `0`。M1 走正式原 UI → Host / Runtime → Adapter → `IZCodeAgentService` → 真实 CLI → OpenCode Go；Fake 与 M0 各按自身路径记录。

## 冷恢复、反馈与继续

在退出上一 App 后重启本提交的 M1 App，原侧栏旧 Task `task_d72ea5b7-21fa-4239-af6c-0fed483ff506`、Participant `participant_7fc03a17-7361-4cc5-8933-59d1da37f74e`、产品 Session `session_7bf85d92-91f2-4201-8517-ed560eef0080` 的历史可读，但原生 Session 先为未知、Composer 和反馈不可用。点击“恢复原会话”后，仍关联原生 `sess_3ff5b616-237f-41c5-a7aa-3ad68e0e62c3`，反馈控件重新变为可用；没有伪造新产品会话。[恢复后反馈可用](restored-feedback-ready.png)。

对最新原生 assistant 消息 `msg_mufsv8fn_b23a79c8-891e-4e5c-8c9d-f0daefc0f140` 点击赞，原控件显示“已赞”；[点赞画面](restored-feedback-liked.png)。再次点击撤回、切到独立 Fake Task 后返回，原控件显示未赞；只读原生 SQLite 的该消息 `feedback=null`。[返回后状态](restored-feedback-returned.png)。真实 CLI 随后在同一旧 Session 内新发 `PR25_POST_FEEDBACK_1C0B292`，返回 `RESTORED_FEEDBACK_READY_1C0B292`；产品 Input `input_238e87cf-66f3-40e1-bdc9-019e88af45b9`、Execution `execution_7f34d0e6-cd5f-49d5-a33a-a067da033ac0` completed，原生 assistant 消息 `msg_muftnnw4_ec73fd77-1453-4161-b1cf-34fba17da702`，模型 `gpt-5.6-luna`。[恢复后下一轮](restored-next-round.png)。配置变化、授权失效和业务终态恢复组合仍待验证。

## Fake A→B→A 与离开返回

从原 toolbar 草稿选择 Fake：A Task `task_3faeee7c-1083-4ac5-b0b6-06c03de5a573` / Session `session_87828d4e-7dee-4128-92a2-40d93e7a88d3` 的 R1、R2、B→A 后 R3 Input 均 completed，分别为 `input_32576fcc-d9cf-461b-93ab-2c8605851bbd`、`input_66f5bda8-573c-4e5d-bcbf-49d261618f8a`、`input_603292ef-0a2e-434d-9a78-0875145b2b6a`。独立 B Task `task_0ed51b12-ee9a-4147-83f6-a6d413f337c7` / Session `session_0a2337a7-cb83-4419-a9f3-4ac4f4dfeff0` 的 `input_d2d69fdd-b1c6-4b83-86b8-ce9394c53c8d` completed。B→A 后原两轮与新第三轮仍属 A，离开到自动化再从侧栏返回历史仍在。[A→B→A](fake-a-b-a.png) · [自动化返回](fake-return-from-automation.png)。Fake fixture 的显示轮数跨 Task 计数，产品身份和输入归属分开。

## 真实 CLI 同进程中断

原 Composer 发送长回答 `PR25_STOP_1C0B292`，正式消息流处理期间点击“请求中断”，待原生证据确认后 UI 才显示“已停止”。[请求前](stop-before-request.png) · [确认后](stop-confirmed.png)。产品 Input `input_b2ada266-2eb3-41fd-b924-9a67760ab276`、Execution `execution_5d74f72b-1c84-4d9c-8be6-82c72a0a616f` 为 stopped；StopRequest `stop_435b5a42-8773-4989-bece-938b4768c20d` 为 confirmed，deliveryStatus delivered，送达证据 `4965d620-77fb-4f28-a861-3878033a178a` 与停止证据 `549b15d6-db67-4179-b08e-e476d5f847d4` 分开。CLI 进程重启后的旧执行对账 / 停止仍为 D。

## 本地检查与未覆盖范围

本提交执行：Contract 9/9、Runtime 47/47、Service / Adapter / attachment 60/60、原生 session mapper 2/2、UI 挂载 / DOM 28/28；`pnpm typecheck`、`pnpm lint`（0 error / 65 warning）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、ADR 索引、修改文件格式和差异检查通过。UI 测试仍有 React `act` 警告。仓库没有适用 `.github` CI；以上是本机结果。M0 flag-off 桌面结果另在下方补录。此提交没有改动 Host、Runtime、Adapter、CLI、依赖或产品装配；较早候选的其他真实 CLI 场景需按原提交阅读，未在本提交重复的必测场景仍按矩阵 D 处理。

## M0 flag-off 对照

同一产品提交关闭 M1 开关后，启动 URL 无 `anyAgentServiceEnabled`。原 Root / Composer 使用 OpenCode Go (Responses) `gpt-5.6-luna` 提交 `M0_1C0B292`，真实模型返回 `M0_NATIVE_1C0B292`，原生 Session `sess_f88197a2-1461-4cd2-bb64-14e16cce7a2b` 的 `session_input` 已 promoted。[原生对话](m0-native.png)。原模型选择器只有 Provider，没有 Harness；[选择器](m0-provider-selector.png)。自动化入口可达，模型设置中可见原 Provider 配置且无 Harness 注册项；[设置](m0-settings.png)。此对照只覆盖所列 M0 基本对话和导航，不能推断全部 M0 能力均通过。
