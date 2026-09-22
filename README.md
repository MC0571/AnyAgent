# AnyAgent

AnyAgent 致力于构建一个开源、本地优先的通用 Agent 桌面工作台。
首个场景是 Coding Agent：让项目、任务、历史、浏览器、权限和工具等工作资产留在用户的工作环境里，Agent 可以更换。

> Your workspace, any agent.

项目目前处于早期开发阶段。长期目标与设计方向见 [VISION.md](VISION.md)。

## 长期定位

AnyAgent 同时面向两层目标：

- **Universal Agent Desktop**：一个完整可用的桌面参考产品。
- **Desktop Agent App Starter Kit**：帮助开发者把已有 Agent 做成桌面产品。

长期形态是 Core + Reference App，通过 Adapter 接入不同 Agent，逐步覆盖 Chat、Task、Browser、Terminal、Diff、Git、Permissions、Workspace 与发行能力。

## 用户价值与使用者

当底层引擎变化时，用户不必搬走工作区、项目历史、任务上下文、浏览器状态和工具配置。价值在于工作资产连续，而不是接入数量。

项目面向直接使用桌面产品的人、编写 Adapter 接入自研 Agent 的开发者，以及在 Core 和参考产品之上定制产品的团队。

## 设计方向

AgentEngine 管理自身的 loop、context、原生工具和私有运行状态；产品层提供可跨 Engine 复用的共享能力，并通过 Adapter 映射到具体 Engine。共享能力包括 Workspace、Session、Persistence、Browser、Permissions、MCP、Skills、Plugins、Tools、Hooks 与 Jobs；事件和能力声明通过产品契约表达。

Workspace 与 Engine 是两条独立轴线，目标环境可以是 Local、SSH、WSL 或 Docker；组合是否可用需要实际验证。Session 绑定原 Engine，跨引擎迁移使用显式 Handoff，统一交互不绕过宿主或引擎的权限边界。

## 社区参与

项目暂不开放社区参与，不接受外部 Pull Request。待项目稳定后，再考虑开放。

## 许可

AnyAgent 使用 [Apache-2.0](LICENSE) 许可。

## 致谢

本项目基于 [ZCode](https://github.com/zai-org/ZCode) 二次开发，感谢 ZCode 的开源贡献。
