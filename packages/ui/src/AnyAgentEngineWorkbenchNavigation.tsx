import {
  WorkbenchCapabilityList,
  shortId,
  taskStatusLabel,
  type WorkbenchEngine,
  type WorkbenchTask,
} from "./AnyAgentEngineWorkbenchParts.js";

export function AnyAgentEngineWorkbenchNavigation({
  engines,
  tasks,
  selectedEngineId,
  selectedTaskId,
  createBlock,
  busyAction,
  onSelectEngine,
  onSelectTask,
  onCreateTask,
}: {
  engines: readonly WorkbenchEngine[];
  tasks: readonly WorkbenchTask[];
  selectedEngineId: string;
  selectedTaskId: string | null;
  createBlock: string | null;
  busyAction: string | null;
  onSelectEngine: (engineId: string) => void;
  onSelectTask: (taskId: string) => void;
  onCreateTask: () => void;
}) {
  const selectedEngine = engines.find((engine) => engine.engineId === selectedEngineId);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
      <section className="border-b border-slate-200 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">创建独立 Task</h2>
          <span className="text-xs text-slate-500">{engines.length} Engines</span>
        </div>
        <select
          aria-label="选择 Engine"
          className="mb-2 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm"
          value={selectedEngineId}
          onChange={(event) => onSelectEngine(event.target.value)}
          disabled={!engines.length || busyAction !== null}
        >
          {engines.length ? null : <option value="">没有已注册的 Engine</option>}
          {engines.map((engine) => (
            <option key={engine.engineId} value={engine.engineId}>
              {engine.engineId}
            </option>
          ))}
        </select>
        <button
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          onClick={onCreateTask}
          disabled={!selectedEngine || !!createBlock || busyAction !== null}
          title={createBlock ?? undefined}
        >
          {busyAction === "create-task" ? "正在创建…" : "创建新 Task"}
        </button>
        {createBlock ? <p className="mt-2 text-xs text-amber-800">{createBlock}</p> : null}
        {selectedEngine ? (
          <div className="mt-3 space-y-1.5 border-t border-slate-200 pt-3">
            <h3 className="text-xs font-semibold text-slate-600">能力与可用性</h3>
            <WorkbenchCapabilityList engine={selectedEngine} compact />
          </div>
        ) : null}
      </section>

      <section className="min-h-0 flex-1 overflow-y-auto p-3">
        <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          已有 Task
        </h2>
        <div className="space-y-1">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`w-full rounded-md border px-3 py-2 text-left ${
                task.id === selectedTaskId
                  ? "border-slate-400 bg-slate-100"
                  : "border-transparent hover:bg-slate-50"
              }`}
              onClick={() => onSelectTask(task.id)}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{shortId(task.id)}</span>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {taskStatusLabel(task.status)}
                </span>
              </span>
              <span className="mt-1 block truncate text-xs text-slate-500">
                {task.engine.engineId} · {task.environment.label ?? task.environment.kind}
              </span>
            </button>
          ))}
          {!tasks.length ? <p className="px-1 py-3 text-sm text-slate-500">还没有 Task。</p> : null}
        </div>
      </section>
    </aside>
  );
}
