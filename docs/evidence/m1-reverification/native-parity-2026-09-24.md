# 原生能力增量实测（2026-09-24）

这是 #26 的进行中记录，不替代 [最终集成复验](README.md)，也不表示 M1 通过。测试窗口使用隔离目录 `/tmp/anyagent-opencode-go.aBEA0z`，macOS arm64，真实 `zcode-cli/0.16.9`，用户在测试 App 内配置的 OpenCode Go (Responses) / `gpt-5.6-luna`。凭据未写入本仓库。

| 被测代码提交 | 经原产品 UI 执行的路径 | 结果与证据 |
| --- | --- | --- |
| `50d1bbd835bc180fa948f4300524c45c4fc9e165` | 新建 Task、发送 `M1_TRUSTED_FEEDBACK_924`、原生 Like、A→B→A、撤销 Like | **通过**：原生反馈按钮可用，返回后选择状态保持，撤销后原生存储反馈为 null；[窗口截图](native-feedback-50d1bbd.png) |
| `bc714b0987f7076917793fe93f0cc8d61bbc8055` | 从上述回答原生分叉，新 Task 继承 `gpt-5.6-luna`，发送 `M1_FORK_CHILD_924` | **通过**：分叉子会话新建后使用来源模型，产品 Input `input_b7ee7cda-a57f-45cc-948b-7cc9161b21b0` 存储为 `opencode-go-responses` / `gpt-5.6-luna`；[窗口截图](native-fork-bc714b0.png) |
| `bc714b0987f7076917793fe93f0cc8d61bbc8055` | 同一子会话通过 Read 工具读取隔离项目 README，随后执行 `/compact` | **通过**：正式消息流用原工具卡片呈现 `GO_WORKSPACE_7F2C9A`；维护记录 `compact_9a99213a-5cd0-4505-a1d5-49faa56fa4b8` 最终 completed，原生 `v4/command_fact` lifecycleStatus 为 success，未伪造 Input / Execution；[窗口截图](native-tool-and-compact-bc714b0.png) |
| `8ad22eac89591d4f05e8c5ddb453933a55b9bcd2` | 新 Task 首轮用 `gpt-5.6-luna` 调用 Read，再在同一产品 Session 切换为同 Provider 的 `grok-4.6` 并完成第二轮 | **通过**：首轮 `GO_WORKSPACE_7F2C9A`，工具后的原生 Like 可用并保存到原生 SQLite；第二轮 `SECOND_MODEL_924`。产品 Task `task_5962b001-86e7-46c0-9a21-f2756df02de8`、Session `session_78fe0248-cc2f-417c-bc1b-f69d1abef67d`、原生 Session `sess_57e3a045-83bc-40cd-897a-d34c1773fb9e` 保持不变；两个 Input 和 Execution 身份不同，`submissionConfig.modelSelection` 分别记录 `gpt-5.6-luna` / `grok-4.6`。[工具反馈截图](native-feedback-after-tool-8ad22ea.png)、[双轮截图](native-model-switch-8ad22ea.png) |
| `d88035fa5af25452b60e13cddf5b21e9616468ce`（仅新增上述证据，产品代码仍为 `8ad22ea`） | 同一真实 CLI Session，从原生“添加上下文”菜单插入工作区文件引用，再经系统文件选择器加入本地附件 | **通过**：文件引用保存为 `[m1-attachment.txt](./m1-attachment.txt)`，原生 Read 工具返回 `ATTACHMENT_MARKER_M1_924`；附件另有产品附件身份 `attachment_77880eee-c132-487d-aa96-e0ea987dc713`，对应轮次直接返回同一标记且工具事件数为 0。[文件引用截图](native-file-mention-d88035f.png)、[附件截图](native-attachment-d88035f.png) |
| `04d7cd19848429c4986ee61043cf7bbadc9a43f5`（仅新增上述证据，产品代码仍为 `8ad22ea`） | 在最新带附件的用户输入上使用原生样式编辑器提交 `M1_NATIVE_EDIT_924` | **部分通过**：新 Input `input_c2587717-a131-453d-a67e-68773f675db3` 有 `revisionOf` 指向原 Input／Execution，原轮次折叠为此前版本，真实 CLI 返回 `EDITED_924`；[窗口截图](native-edit-d88035f.png)。**缺口**：编辑器未显示原附件，而原生编辑保留了附件，产品新 Input 也沿用旧附件 ID；不能把这一编辑体验判为完成 |

`bc714b0` 的子会话完成工具调用后，其所有回答的“赞／踩”曾变成不可用。`8ad22ea` 修复了原生推理行被误当作重复正文行的问题，并在新的真实 CLI Task 上复测通过。这里验证了工作区文件引用与本地文本附件；网页、共享上下文和其他引用类别仍未实测。编辑器隐藏但保留旧附件的缺口须修复并补验。最终候选仍须按 #21 复测所有受影响路径。
