# 决策记录 0003：跨 Engine 协作以 Task 与 Workflow 为边界

* 状态：Accepted
* 类型：Architecture
* 决策简述：每个 Session 绑定单一 Engine；Task 与 Workflow 协调跨 Engine 的 Agent Instance 与 Session，必要时通过显式 Handoff 创建新 Session。
* 当前修订：2026-09-22

## 当前决定

每个 Session 始终绑定一个 Engine，恢复时继续使用原 Engine，以保持持续对话、历史、上下文和运行状态的归属清楚。Task 与 Workflow 是跨 Engine 协作的产品边界，可以协调由相同或不同 Engine 驱动的 Agent Instance 及其 Session。

Agent Instance 表达参与者身份、使用的 Engine 和承担的职责；不固定 Agent Instance 与 Session 之间是一对一还是一对多的关系。产品层通过共同契约协调任务依赖、消息、产物、参与者状态、生命周期与权限；各 Engine 保留自己的私有上下文、原生工具与运行状态，授权工作区、产物和显式消息承担协作媒介。

共享资产的访问、并发修改、冲突处理和结果整合保持明确归属与协调责任。Handoff 创建新 Session 并传递目标、摘要、差异、文件、TODO 和必要上下文；协作可以采用交接、串行、并行或交互式形式，产品呈现实际能力以及控制生效状态和影响范围。

## 理由

Session 绑定 Engine 可以保留持续对话、上下文和私有运行状态的真实归属，Task 与 Workflow 则提供跨 Session 的协调空间。

显式 Handoff 区分可复用材料与无法迁移的私有状态；明确共享资产的协调责任，可以让协作结果可追踪。代价是产品必须如实表达参与 Engine 的能力差异和控制范围，而不能承诺统一的恢复或介入行为。

## 不采用

- 不以共享或合并 Harness 的私有上下文和运行状态作为跨 Engine 协作的前提。
- 不在本决策中预设 Agent Instance 与 Session 的一对一或一对多关系。
- 不把跨 Engine 协作限定为单一的 Handoff 或单一的顺序流程。
- 不假定所有 Engine 都支持相同的消息、运行中介入或恢复能力。
- 不绕过 Engine 或执行宿主的权限边界，也不把未生效的控制呈现为已生效。

## 关联事实载体

- [跨 Engine 协作](../../VISION.md#跨-engine-协作)
- [Session 恢复与 Handoff](../../VISION.md#session-恢复与-handoff)
- [任务、历史与自动化](../../VISION.md#任务历史与自动化)

## 修订记录

### 2026-09-22

明确 Session 与 Engine 的归属及 Task/Workflow 的协作边界，避免跨 Engine 协作侵入私有运行状态。
