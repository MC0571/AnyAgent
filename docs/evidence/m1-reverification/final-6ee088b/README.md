# `fix/m2-closure-conditional` 候选自动化检查

产品代码候选完整 SHA：`6ee088bd261d531b7a4b6b93859b25bdb4a0086b`。比较基线：PR #25 合并提交 `d813b84318aa554c65c162e533c079ba9ed16bdc`。本记录绑定上述提交上的代码；检查开始时工作区干净，记录写入发生在检查之后。

检查环境为 macOS Darwin 27.0.0 arm64、Node `v24.14.0`、pnpm `10.33.2`。以下命令均在仓库根目录本机执行，不是 CI 运行。

| 检查                                                                           | 当前候选结果    | 覆盖                                                                                                                                                   |
| ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir packages/anyagent-runtime test`                                    | **通过：63/63** | Runtime 单元测试；包括带附件队列晋升、取消清理、TTL 与重启恢复、队列项编辑时保留／移除／新增附件，以及失败或停止终态后不再向原生 Engine 回复待答交互。 |
| `node --import tsx --test packages/services/test/anyagentZcodeAdapter.test.ts` | **通过：66/66** | Adapter 单元测试；包括只派发当前工作区目录仍声明的自定义 slash 命令，并拒绝过期、未知或 `/goal` 输入落入普通文本派发。                                 |
| `pnpm typecheck`                                                               | **通过**        | 仓库现有 TypeScript project-reference 检查，包含 `packages/ui` 类型检查；这不验证 UI 运行时行为。                                                      |
| UI 测试                                                                        | **未运行**      | 本次证据范围只执行非 UI 检查。`packages/ui/test/EngineConversation.test.tsx` 中的新增队列附件及自定义命令用例未执行。                                  |
| 桌面／真实 CLI／M0 flag-off smoke                                              | **未运行**      | 当前候选没有正式 UI 操作、真实 CLI 结果、双库对账或 M0 当前候选回归观察。                                                                              |

## 三类关闭对象

### M0 Verified

本候选没有新增 M0 flag-off 验证。已有 M0 smoke 和较早候选观察继续保留原提交归属，不由本记录扩展。

### Product Parity：Required／Conditional／Deferred

PR 候选将当前 CLI 自定义 slash 命令的 Host／Adapter 路由接入正式 M1 Composer 路径，并加入当前工作区命令目录校验；Runtime 增加队列附件受控晋升和编辑流程，支持选择性保留／移除旧附件、加入新 Host 暂存附件，并在原 Session 和 TTL 约束内跨重启恢复。Runtime 与 Adapter 对应单元测试通过。

这些结果只证明 Runtime／Adapter 层的自动化断言。新增 UI 测试未运行，真实 CLI 与正式桌面操作未执行，因此自定义 slash 和附件队列仍未取得当前候选的产品路径通过证据。固定 CLI `/goal` 写入／恢复与运行中 compact 仍是接入缺口；#26 的 Required／Conditional／Deferred 分类本身未改变。

### M1 Contract

当前 Runtime 测试覆盖失败或停止的 Execution 终结后，待答交互从可派发状态退役且不会再调用 Engine；Adapter 测试覆盖自定义命令必须仍在当前工作区目录中。它们是低层自动化证据，不证明真实原生 CLI 断线恢复、未知结果／副作用对账、迟到交互竞态的桌面行为，也不关闭整个 M1 Contract。

本候选没有窗口截图或录屏。新代码路径的 UI 控件可见状态、交互顺序、真实 CLI 命令执行、M0 flag-off 基础回归，以及当前候选的断线／未知结果和副作用去重仍未由本轮检查覆盖。
