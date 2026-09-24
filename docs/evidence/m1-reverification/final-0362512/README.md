# 0362512 原生桌面实测轨迹（中间候选）

被测产品代码：`03625127d6f87b8a0e14b452871c34fdaef92a4d`。本记录保留该候选的可核查场景，不替代后续最终代码候选的必测回归；尤其结构化提问在此候选**失败**。

## 环境和方法

- macOS Darwin arm64；Node 24.14.0、pnpm 10.33.2、Electron 41.0.3；仓内真实 zcode-cli 0.16.9；ZCode Adapter 为上述被测提交；M1 开关 `ANYAGENT_M1_WORKBENCH=1`。
- 隔离 App 数据在 `/tmp/anyagent-opencode-go.aBEA0z/home`，隔离项目为同目录的 `project`；使用此前在隔离 App 已配置并验证可用的 OpenCode Go (Responses)。凭据未写入本目录。
- 用该仓库的 `pnpm dev:desktop:prod` 启动正式 macOS App。所有操作从原 Root、侧栏、Composer、审批和提问控件完成，经 Host／Runtime／Adapter／真实 CLI。截图由同一窗口取得；产品存储只读查询 `home/anyagent-m1.sqlite`，原生存储只读查询 `home/.zcode/cli/db/db.sqlite`。
- 查询依据：`runtime_records` 按 `task_id`、`kind`、`created_at` 查看产品记录；原生 `session_input` 按 `session_id`、`admitted_sequence` 查看输入；文件结果在隔离项目实际核对。日志留在隔离目录 `app-pr25-final.log` 与 `app-pr25-restart.log`，未把可能包含配置的原始日志提交。

## 同一 Task 冷恢复及控制

产品 Task `task_d72ea5b7-21fa-4239-af6c-0fed483ff506`、Participant `participant_7fc03a17-7361-4cc5-8933-59d1da37f74e`、Session `session_7bf85d92-91f2-4201-8517-ed560eef0080`，原生 Session 始终为 `sess_3ff5b616-237f-41c5-a7aa-3ad68e0e62c3`。第一轮用 `gpt-5.6-luna/max`，第二轮在 Harness · zcode 内选同 Provider `grok-4.6/xhigh`，键盘 Return 提交；两轮分别返回 `FINAL_R1_925`、`FINAL_R2_GROK_925`。[首轮](native-r1.png)、[换模型后双轮](native-r2-model-switch.png)。产品两轮 Input／Execution 为 completed；原生 `session_input` 序号 0、1，均在同一原生 Session。

退出隔离 App 后用同一启动器重启；从原侧栏进入旧 Task，先显示只读历史和“恢复原会话”，并未自动发送。点击恢复后原 Composer 才解锁，[恢复后第三轮前](native-restored-before-r3.png)；第三轮返回 `FINAL_R3_RESTORED_925`，[三轮结果](native-r3-after-restart.png)。产品 Task／Participant／Session 及原生 Session ID 未变，第三轮 Input `input_ed6b135c-a5a0-4e15-881f-5c0b0878480e`、Execution `execution_5b1aef7c-5892-4010-a669-3074f3eee3a9` 为 completed；原生 `session_input` 序号 2，未重放前两轮。

第四轮长回答从正式 UI 请求中断，[停止画面](native-stop.png)。StopRequest `stop_de763864-6e4d-4ba2-90c7-07839e95dd39` 的 `deliveryStatus=delivered`、`status=confirmed`，分别有 `deliveryEvidence.evidenceId=0d02f0fc-e3dc-466f-bbe9-63fc14c92863` 和不同的 `stopEvidence.evidenceId=18f18f6f-ab70-4231-8a06-8bb85144927c`；对应 Execution `execution_7ba173c1-2991-4fcb-952d-fd043ef00ee2` 为 stopped。原生序号 3 只出现一次。该证据证明本次同进程中断，不证明冷重启后仍在运行的原生执行可停止。

## 审批、文件和提问

请求在隔离项目创建 `pr25-approval-925.txt`，真实 CLI 发出 Write 审批，[待决](native-approval-pending.png)；UI 仅允许本次后，原生写入并返回 `APPROVAL_DONE_925`，[完成和文件摘要](native-approval-allowed.png)。产品 Approval `approval_36d65ad2-ccd1-4a69-aaad-b011e70fe555` 为 forwarded，文件实际内容为 `APPROVED_ONCE_925`。随后另一轮请求创建 `pr25-denied-925.txt`，选择拒绝；产品 Approval `approval_fde890bc-fc8d-4896-b6d1-71e02459fa40` 为 rejected，[拒绝结果](native-approval-denied.png)，目标文件实际不存在。

在前一成功写入轮次打开[撤销预览](native-rewind-preview.png)，显示安全 1／不安全 0；执行后产品 FileRewindOperation `file-rewind_66b8022b-7d5f-4ff9-a70a-4d20c856e9dd` 为 applied，[UI 已撤销](native-rewind-applied.png)，隔离项目中的该文件实际不存在。

真实 CLI 通过 AskUserQuestion 发出单选结构化提问，[待答复截图](native-user-question.png)，产品 UserInput `user-input_1542044a-d0ba-4727-b5c5-4f2db8baa8f5` 关联本 Task／Session／Execution、原生请求 `perm_8469b8fd-eece-411e-8ce6-144dcff2ad46`。选择 B 后，Adapter 因只接受字符串而把原组件提交的结构化答复判为 unsupported；原执行未继续，随后人工中断并取得停止证据。已在工作区修复映射并增加 Adapter 回归测试，但本场景**未通过**，需在包含修复的最终候选重跑 UI→真实 CLI 全链。

本次未测试连接断开后对账、重启后进行中的原生停止、授权失效或配置变化下恢复、队列／compact、Fake A→B→A，以及其他矩阵必测项。其结果继续按上层唯一矩阵记为 D。
