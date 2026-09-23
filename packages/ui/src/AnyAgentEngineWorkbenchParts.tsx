import type { IAnyAgentService } from "@zcode/services";

export type WorkbenchTask = NonNullable<Awaited<ReturnType<IAnyAgentService["getTask"]>>>;
export type WorkbenchEngine = Awaited<ReturnType<IAnyAgentService["listEngines"]>>[number];
export type WorkbenchContext = Awaited<ReturnType<IAnyAgentService["getCreateTaskContext"]>>;
export type CapabilityName = keyof WorkbenchEngine["capabilities"];
export type CapabilityStatus = WorkbenchEngine["capabilities"][CapabilityName];

export type WorkbenchInput = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  text: string;
  status: string;
  receivedAt: number;
  acceptedAt: number | null;
  startedAt: number | null;
  terminalAt: number | null;
  error: string | null;
};

export type WorkbenchExecution = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  inputId: string;
  status: string;
  acceptedAt: number;
  startedAt: number | null;
  terminalAt: number | null;
  result: string | null;
  error: string | null;
};

export type WorkbenchEvent = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  inputId: string | null;
  executionId: string | null;
  nativeEventId: string;
  streamId: string;
  sourceSequence: number | null;
  deliverySequence: number;
  observedAt: number;
  source: string;
  type: string;
  payload: Readonly<Record<string, unknown>>;
  duplicateOf: string | null;
};

export type WorkbenchApproval = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  executionId: string;
  operation: string;
  scope: string | null;
  options: readonly { id: string; label: string; decision: "approve" | "reject" | "other" }[];
  expiresAt: number | null;
  status:
    | "pending"
    | "forwarded"
    | "expired"
    | "unknown"
    | "already-answered"
    | "unsupported"
    | "rejected";
  repliedOptionId: string | null;
};

export type WorkbenchUserInput = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  executionId: string;
  prompt: string;
  inputKind: "text" | "choice" | "form";
  options: readonly { id: string; label: string }[];
  expiresAt: number | null;
  status:
    | "pending"
    | "forwarded"
    | "expired"
    | "unknown"
    | "already-answered"
    | "unsupported"
    | "rejected";
  response: unknown;
};

export type WorkbenchStopRequest = {
  id: string;
  taskId: string;
  participantId: string;
  sessionId: string;
  executionId: string;
  requestedAt: number;
  status:
    | "requested"
    | "unsupported"
    | "temporarily-unavailable"
    | "authorization-required"
    | "unknown"
    | "confirmed";
  reason: string | null;
};

export type WorkbenchIntegrityIssue = {
  id: string;
  taskId: string;
  sessionId: string;
  type: string;
  occurredAt: number;
  eventId: string | null;
  detail: string;
};

export type WorkbenchHistory = {
  taskId: string;
  inputs: readonly WorkbenchInput[];
  executions: readonly WorkbenchExecution[];
  events: readonly WorkbenchEvent[];
  approvals: readonly WorkbenchApproval[];
  userInputs: readonly WorkbenchUserInput[];
  stopRequests: readonly WorkbenchStopRequest[];
  integrityIssues: readonly WorkbenchIntegrityIssue[];
};

export const capabilityNames = [
  ["session.create", "创建 Session"],
  ["execution.run", "运行输入"],
  ["execution.interrupt", "请求中断"],
  ["approval.respond", "回答审批"],
  ["user-input.respond", "回答用户输入"],
] as const satisfies readonly (readonly [CapabilityName, string])[];

export function timeLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "未记录";
  return new Date(value).toLocaleString();
}

export function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function taskStatusLabel(status: WorkbenchTask["status"]): string {
  const labels: Record<WorkbenchTask["status"], string> = {
    active: "进行中",
    frozen: "已冻结",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    abandoned: "已放弃协调",
  };
  return labels[status] ?? status;
}

export function sessionStatusLabel(status: WorkbenchTask["session"]["status"]): string {
  const labels: Record<WorkbenchTask["session"]["status"], string> = {
    creating: "创建中",
    active: "可用",
    unknown: "状态未知",
    failed: "创建失败",
    closed: "已关闭",
  };
  return labels[status] ?? status;
}

export function recordStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    received: "产品已接收",
    "native-accepted": "Engine 已接纳",
    started: "执行已开始",
    accepted: "已接纳",
    completed: "已完成",
    failed: "已确认失败",
    stopped: "已确认停止",
    unknown: "结果未知",
    rejected: "已拒绝",
    pending: "等待答复",
    forwarded: "已转交 Engine",
    expired: "已过期",
    requested: "已请求中断，等待确认",
    unsupported: "不支持中断",
    "temporarily-unavailable": "暂不可用",
    "authorization-required": "授权不足",
    confirmed: "已确认停止",
  };
  return labels[status] ?? status;
}

export function capabilityLabel(status: CapabilityStatus | undefined): string {
  if (!status) return "状态未知";
  if (status.support === "unsupported") return "不支持";
  if (status.support === "unknown") return "支持状态未知";
  switch (status.availability) {
    case "available":
      return "支持 · 可用";
    case "temporarily-unavailable":
      return "支持 · 暂不可用";
    case "authorization-required":
      return "支持 · 授权不足";
    default:
      return "支持 · 可用性未知";
  }
}

export function capabilityBlockReason(status: CapabilityStatus | undefined): string | null {
  if (!status) return "能力状态未知。";
  if (status.support === "unsupported") return status.reason ?? "Engine 不支持此操作。";
  if (status.support === "unknown") return status.reason ?? "Engine 支持情况未知。";
  if (status.availability === "authorization-required") return status.reason ?? "当前授权不足。";
  if (status.availability === "temporarily-unavailable") return status.reason ?? "此能力暂不可用。";
  if (status.availability === "unknown") return status.reason ?? "此能力当前是否可用未知。";
  return null;
}

export function capabilityPillClass(status: CapabilityStatus | undefined): string {
  if (!status || status.support === "unknown" || status.availability === "unknown") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-800";
  }
  if (status.support === "unsupported") return "border-slate-500/30 bg-slate-500/10 text-slate-600";
  if (status.availability === "available")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800";
  if (status.availability === "authorization-required")
    return "border-orange-500/30 bg-orange-500/10 text-orange-800";
  return "border-amber-500/30 bg-amber-500/10 text-amber-800";
}

export function WorkbenchCapabilityList({
  engine,
  compact = false,
}: {
  engine: WorkbenchEngine;
  compact?: boolean;
}) {
  return (
    <ul className={compact ? "space-y-1.5" : "space-y-2"}>
      {capabilityNames.map(([key, label]) => {
        const capability = engine.capabilities[key];
        return (
          <li
            key={key}
            className={
              compact ? "flex flex-col gap-0.5 text-[11px]" : "flex flex-col gap-1 text-xs"
            }
          >
            <span className="flex items-center justify-between gap-2 text-slate-700">
              {label}
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${capabilityPillClass(capability)}`}
              >
                {capabilityLabel(capability)}
              </span>
            </span>
            {capability?.reason ? (
              <span className="text-slate-500">{capability.reason}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function jsonLabel(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
  } catch {
    return "无法显示此事件载荷";
  }
}

export function provenanceLabel(provenance: Readonly<Record<string, string>> | undefined): string {
  if (!provenance || !Object.keys(provenance).length) return "未提供";
  return Object.entries(provenance)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

export function canActOnTask(task: WorkbenchTask, capability: CapabilityName): string | null {
  if (capability !== "execution.interrupt") {
    if (task.status !== "active")
      return `Task 当前状态为“${taskStatusLabel(task.status)}”，不接收新的业务请求。`;
    if (task.session.status !== "active")
      return `产品 Session 当前状态为“${sessionStatusLabel(task.session.status)}”。`;
  }
  return capabilityBlockReason(task.engine.capabilities[capability]);
}

function eventTitle(event: WorkbenchEvent): string {
  const status =
    typeof event.payload.status === "string" ? ` · ${recordStatusLabel(event.payload.status)}` : "";
  return `${event.type}${status}`;
}

export function WorkbenchHistory({
  history,
  isLoading,
}: {
  history: WorkbenchHistory | null;
  isLoading: boolean;
}) {
  if (!history) {
    return (
      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {isLoading
          ? "正在读取历史…"
          : "此 Task 的历史当前不可用；不会根据 UI 当前选择推断事件归属。"}
      </p>
    );
  }
  return (
    <>
      <div className="mb-5 space-y-2">
        {history.inputs.map((input) => (
          <article
            key={`input:${input.id}`}
            className="ml-auto max-w-[85%] rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>输入 · {recordStatusLabel(input.status)}</span>
              <time>{timeLabel(input.receivedAt)}</time>
            </div>
            <p className="whitespace-pre-wrap text-sm">{input.text}</p>
            <div className="mt-2 text-[11px] text-slate-500">Input {shortId(input.id)}</div>
            {input.error ? <p className="mt-1 text-xs text-red-700">{input.error}</p> : null}
          </article>
        ))}
        {history.executions.map((execution) => (
          <article
            key={`execution:${execution.id}`}
            className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>Execution · {recordStatusLabel(execution.status)}</span>
              <time>{timeLabel(execution.startedAt ?? execution.acceptedAt)}</time>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {shortId(execution.id)} · 来源输入 {shortId(execution.inputId)}
            </div>
            {execution.result ? (
              <p className="mt-2 whitespace-pre-wrap text-sm">{execution.result}</p>
            ) : null}
            {execution.error ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-red-700">{execution.error}</p>
            ) : null}
          </article>
        ))}
        {!history.inputs.length && !history.executions.length ? (
          <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            此 Task 尚无输入或 Execution 记录。
          </p>
        ) : null}
      </div>

      <section className="border-t border-slate-200 pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">公开 Engine 事件</h4>
          <span className="text-xs text-slate-500">{history.events.length} 条</span>
        </div>
        <div className="space-y-2">
          {[...history.events]
            .sort((a, b) => a.observedAt - b.observedAt)
            .map((event) => (
              <details key={event.id} className="rounded-md border border-slate-200 bg-white p-3">
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{eventTitle(event)}</span>
                    <time className="text-xs text-slate-500">{timeLabel(event.observedAt)}</time>
                  </div>
                  <div className="mt-1 break-all text-[11px] text-slate-500">
                    {event.source} · sequence {event.sourceSequence ?? "未知"} · Task{" "}
                    {shortId(event.taskId)} · Participant {shortId(event.participantId)} · Session{" "}
                    {shortId(event.sessionId)}
                    {event.executionId ? ` · Execution ${shortId(event.executionId)}` : ""}
                    {event.duplicateOf ? ` · 重复事件，原记录 ${shortId(event.duplicateOf)}` : ""}
                  </div>
                </summary>
                <pre className="mt-3 max-h-72 overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700">
                  {jsonLabel(event.payload)}
                </pre>
              </details>
            ))}
          {!history.events.length ? <p className="text-sm text-slate-500">尚无公开事件。</p> : null}
        </div>
      </section>
    </>
  );
}
