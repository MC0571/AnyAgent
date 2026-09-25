# `44cfb92` 中间产品候选记录

完整产品代码提交：`44cfb92096238882c24c87315b271a2d8428aa4a`。这不是最终验收候选；[唯一收口矩阵](../README.md#m0-单参与者能力收口矩阵)仍保留 D 项。

在隔离 macOS App、`ANYAGENT_M1_WORKBENCH=1`、Electron 41.0.3、固定真实 CLI 0.16.9、OpenCode Go 已配置环境中，从原侧面板内置浏览器打开本机 HTTP 测试页 `127.0.0.1:43128`，其按钮文本为 `PR25_WEB_ELEMENT_MARKER_925`。在原侧栏已有 Harness Task 显式恢复后，点击“选择网页元素加入聊天”并直接点按钮，原 Composer 出现“1 个网页元素”芯片：[窗口截图](web-element-chip.png)。这只证明浏览器拾取事件进入原 Composer；尚未完成真实模型输入、CLI user message 与回答的同场景对账，网页能力仍不能判 A。

本机检查：Contract 9/9、Runtime 53/53、Service / Adapter / attachment 75/75、原生 mapper / terminal / slash / 新停轮历史定向 6/6、挂载 UI / DOM / picker 33/33；`pnpm typecheck`、`pnpm --dir apps/zcode-cli/packages/core typecheck`、`pnpm lint`（0 error、65 warning）、`pnpm architecture:check -- --changed`（0 violation）、`pnpm build:bootstrap`、ADR 索引、修改文件格式及 `git diff --check` 通过。日志保存在本机 `/tmp/pr25-final-44cfb92-*.log`。独立代码复审随后指出该候选原生停止轮在元数据存储故障及 compact 后冷恢复等路径仍有阻塞，故这些检查与拾取截图均不构成最终验收。
