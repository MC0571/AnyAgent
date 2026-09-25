# `6f84500` 增量桌面记录（非最终候选）

被测产品提交：`6f84500c0b0c8969c21294e102ee33291444e820`。隔离 macOS App 使用 `/tmp/anyagent-opencode-go.aBEA0z` 的项目、home 与 Electron 数据，经 `pnpm dev:desktop:prod`、`ANYAGENT_M1_WORKBENCH=1` 启动。Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、真实 zcode-cli 0.16.9、ZCode Adapter `m1.2`；已配置 OpenCode Go (Responses) `gpt-5.6-luna`，未重新输入凭据。App 原始日志留在隔离目录 `app-6f84500-m1.log`。

原 Composer 的模型菜单明确选择 **Harness · zcode · OpenCode Go (Responses)/gpt-5.6-luna**，通过正式 UI → Host/Runtime → Adapter → 真实 CLI 创建产品 Task `task_6b939111-1648-428c-802c-dd1ab0afe7e9`、Participant `participant_5ad5d55b-3205-4785-ad95-4a1e6864272f`、产品 Session `session_bc9dfaf2-fac4-4e50-a694-309a5c7f3a76`、原生 Session `sess_b7159530-16fb-4ec5-8ff1-fd6cef59324a`。源轮用 Read 工具读取隔离项目 README.md，随后流式生成 40 条建议及 `END_M1_6F84500`。源轮运行中第二输入进入产品队列；原 UI 的“编辑”撤回该项，Composer 恢复原文字，产品 Input `input_6ba7f02e-309a-4b13-901b-11ab76b02e60` 标为 `cancelled`，原生 `session_input` 只有源轮一项，未把撤回项发给 CLI。[真实 M1 队列编辑截图](real-m1-queue-edit-restored.png)、[同一场景的只读产品与原生存储选取字段](runtime-native-crosscheck.json)。

另一次从默认 Provider 新建的对话属于 **M0 路径**；[该路径截图](real-cli-queue-rounds.png)只用于证明测试时识别入口，不算 M1 验收。之后修复持久化失败问题时共享工作树触发 Vite HMR，正在运行的 App 报 React hook 顺序异常；该瞬时热重载结果不作为产品候选稳定启动的回归结论。离开再返回和重启恢复仍需在后续稳定产品提交上重测。

此提交经独立代码补审仍有恢复草稿持久化失败时旧文本重启复现的 P2 缺口，因此不是最终技术候选。后续产品补丁影响草稿处理，本页不能替代补丁后的最终窗口测试。
