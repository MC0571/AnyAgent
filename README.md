# AnyAgent

AnyAgent 致力于构建一个开源、本地优先的通用 Agent 桌面工作台。
首个场景是 Coding Agent：让项目、任务、历史、浏览器、权限和工具等工作资产留在用户的工作环境里，Agent 可以更换。

> Your workspace, any agent.

项目目前处于定位与愿景阶段，还没有代码、构建、安装或运行入口；[VISION.md](VISION.md) 描述的是目标设计，不代表功能已经实现。

## 长期定位

AnyAgent 同时面向两层目标：

- **Universal Agent Desktop**：一个完整可用的桌面参考产品。
- **Desktop Agent App Starter Kit**：帮助开发者把已有 Agent 做成桌面产品。

长期形态是 Core + Reference App，通过 Adapter 接入不同 Agent，逐步覆盖 Chat、Task、Browser、Terminal、Diff、Git、Permissions、Workspace 与发行能力。

## 用户价值与使用者

当底层引擎变化时，用户不必搬走工作区、项目历史、任务上下文、浏览器状态和工具配置。价值在于工作资产连续，而不是接入数量。

项目面向直接使用桌面产品的人、编写 Adapter 接入自研 Agent 的开发者，以及在 Core 和参考产品之上定制产品的团队。

## 设计方向

产品服务层管理 Workspace、Session、Persistence、Browser、Permission、MCP、Skills、plugins、Tools、Hooks 与 Jobs 等共享能力；AgentEngine 管理自身的 loop、context 与 tools，并通过产品契约提供事件和能力声明。

Workspace 与 Engine 是两条独立轴线，目标环境可以是 Local、SSH、WSL 或 Docker；组合是否可用需要实际验证。Session 绑定原 Engine，跨引擎迁移使用显式 Handoff，统一交互不绕过宿主或引擎的权限边界。

## 参与

先阅读 [VISION.md](VISION.md)，围绕可验证的切片实现或反馈；基础切片应在同一工作区验证会话、stream、tool、shell、file、diff、approval、stop 和 resume，再根据结果扩展共享 Browser、远程工作区与更多引擎。

## 许可

AnyAgent 使用 [Apache-2.0](LICENSE) 许可。
