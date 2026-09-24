# 原生能力增量实测（2026-09-24）

这是 #26 的进行中记录，不替代 [最终集成复验](README.md)，也不表示 M1 通过。测试窗口使用隔离目录 `/tmp/anyagent-opencode-go.aBEA0z`，macOS arm64，真实 `zcode-cli/0.16.9`，用户在测试 App 内配置的 OpenCode Go (Responses) / `gpt-5.6-luna`。凭据未写入本仓库。

| 被测代码提交 | 经原产品 UI 执行的路径 | 结果与证据 |
| --- | --- | --- |
| `50d1bbd835bc180fa948f4300524c45c4fc9e165` | 新建 Task、发送 `M1_TRUSTED_FEEDBACK_924`、原生 Like、A→B→A、撤销 Like | **通过**：原生反馈按钮可用，返回后选择状态保持，撤销后原生存储反馈为 null；[窗口截图](native-feedback-50d1bbd.png) |
| `bc714b0987f7076917793fe93f0cc8d61bbc8055` | 从上述回答原生分叉，新 Task 继承 `gpt-5.6-luna`，发送 `M1_FORK_CHILD_924` | **通过**：分叉子会话新建后使用来源模型，产品 Input `input_b7ee7cda-a57f-45cc-948b-7cc9161b21b0` 存储为 `opencode-go-responses` / `gpt-5.6-luna`；[窗口截图](native-fork-bc714b0.png) |
| `bc714b0987f7076917793fe93f0cc8d61bbc8055` | 同一子会话通过 Read 工具读取隔离项目 README，随后执行 `/compact` | **通过**：正式消息流用原工具卡片呈现 `GO_WORKSPACE_7F2C9A`；维护记录 `compact_9a99213a-5cd0-4505-a1d5-49faa56fa4b8` 最终 completed，原生 `v4/command_fact` lifecycleStatus 为 success，未伪造 Input / Execution；[窗口截图](native-tool-and-compact-bc714b0.png) |

**仍待修复**：上述子会话完成工具调用后，其所有回答的“赞／踩”变成不可用。故反馈不能据首个通过案例判为全面通过。原生文件上下文入口虽出现，提交到 Harness 的结构化引用语义尚未核实。最终候选须重新执行受影响路径，并按 #21 复测。
