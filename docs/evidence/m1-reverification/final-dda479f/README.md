# PR #25 产品代码 `dda479f` 增量复验

完整被测产品代码提交：`dda479f031212729dfcb289a983161e32686e872`。此提交在 `432eb7075024639b1e5e9f0692c20666f85d7fa7` 上修正冷启动误报：所有 Input／Execution 已终态的旧 Session 重启后仍需显式恢复，但不再凭重启本身追加 `stream-ended-unknown` 诊断。先前候选的证据保留在[原目录](../final-432eb70/README.md)，不能替代此提交的全量必测回归。

## 环境与检查

macOS Darwin arm64；Node 24.14.0、pnpm 10.33.2、Electron 41.0.3；固定真实 `zcode-cli` 0.16.9、ZCode Adapter `m1.2`。隔离 App home、Electron 数据和项目为 `/tmp/anyagent-opencode-go.aBEA0z`；已复用隔离 App 内现有 OpenCode Go (Messages) 配置，模型 `qwen3.8-flash`，未将凭据写入仓库。正式 UI 经 AnyAgent Host／Runtime → ZCode Adapter → 既有 ZCode 服务 → 真实 CLI → 该模型服务。

本机在此提交运行：Contract 9/9，Runtime 55/55，Service／Adapter／附件 75/75，原生映射等 28/28，UI 实际挂载／DOM 33/33。`pnpm typecheck`、`pnpm lint`（0 error、65 warning）、`pnpm architecture:check -- --changed`、`pnpm build:bootstrap`、ADR 索引、修改文件格式和 `git diff --check` 通过。日志为本机 `/tmp/pr25-dda-{contract,runtime,service,native,ui,type,lint,architecture,build}.log`；仓库无适用 CI，PR 检查列表为空。这些结果只适用于本提交。

## 原生桌面冷恢复与反馈

1. 从原“新建任务”和 Composer 建立 Task，连续两轮真实 CLI 分别返回 `DDA_R1_OK`、`DDA_R2_OK`。退出隔离 App 后重新启动，原侧栏进入旧 Task。历史可读，但输入禁用，显示“恢复原会话”；没有自动取得执行资格。
2. 显式点击恢复后，原 Task／Participant／产品 Session／原生 Session 保持不变，再由原 Composer 发第三轮，真实 CLI 返回 `DDA_R3_OK`。[双库选取字段](cold-restore-crosscheck.json)记录退出前两轮、恢复后第三轮、各自 Input／Execution、同一原生 Session 与零条完整轮误报诊断。数据库快照采于第三轮后，后续第四轮不改变这一时点的判断。
3. 同一 Task 第四轮要求真实 `Read` 工具读取隔离项目 `README.md`，正式消息流出现工具行并返回 `TOOL_READ_DDA_OK`。对该工具轮回答点赞，切换至另一 Task 再返回，UI 仍显示“已赞”，原生 assistant 的 `assistantFeedback` 为 `like`。[本轮产品事件、原生 Turn／tool part／反馈](tool-feedback-crosscheck.json)。第三轮回答的 Like→Dislike→撤回也经 UI 操作并在当时读取原生值，但中间值没有保存为独立持久快照，不能将该矩阵项判为完整通过。

桌面窗口截图曾通过 CUA 观察，但没有成功保存为仓库文件；浏览器对保存截图所需的本地 `data:` 页面明确拒绝，未再尝试绕过。此提交的桌面证据层级是原生窗口操作观察加同一场景的产品／原生存储选取字段，缺少可交付的窗口截图。没有把该缺口写作已通过。

此提交仅修正上述冷启动诊断。配置变化与授权失效时的真实 App 负例、断线后的原执行对账，以及其他矩阵必测组合仍未在此提交完成。之后若产品代码再变，此目录只作历史证据；最新分类仍以[唯一收口矩阵](../README.md#m0-单参与者能力收口矩阵)为准。
