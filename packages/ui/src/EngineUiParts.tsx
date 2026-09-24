import type { IAnyAgentService } from "@zcode/services";
import type { EngineCapability, CapabilityStatus } from "@anyagent/engine-contract";

export type EngineTask = NonNullable<Awaited<ReturnType<IAnyAgentService["getTask"]>>>;
export type EngineHistory = NonNullable<Awaited<ReturnType<IAnyAgentService["getHistory"]>>>;
export type EngineInput = EngineHistory["inputs"][number];
export type EngineExecution = EngineHistory["executions"][number];
export type EngineEvent = EngineHistory["events"][number];
export type EngineApproval = EngineHistory["approvals"][number];
export type EngineUserInput = EngineHistory["userInputs"][number];
export type CurrentEngine = Awaited<ReturnType<IAnyAgentService["listEngines"]>>[number];
export type CapabilityName = EngineCapability;
export type CapabilityState = CapabilityStatus;

export const capabilityNames = [
  ["session.create", "创建 Session"],
  ["session.fork", "从回答分叉"],
  ["execution.run", "运行输入"],
  ["execution.revise", "编辑或重试轮次"],
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

export function taskStatusLabel(status: EngineTask["status"]): string {
  const labels: Record<EngineTask["status"], string> = {
    active: "进行中",
    frozen: "已冻结",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    abandoned: "已放弃协调",
  };
  return labels[status] ?? status;
}

export function sessionStatusLabel(status: EngineTask["session"]["status"]): string {
  const labels: Record<EngineTask["session"]["status"], string> = {
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
    unsupported: "不支持",
    "temporarily-unavailable": "暂不可用",
    "authorization-required": "授权不足",
    confirmed: "已确认停止",
  };
  return labels[status] ?? status;
}

export function capabilityLabel(status: CapabilityState | undefined): string {
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

export function capabilityBlockReason(status: CapabilityState | undefined): string | null {
  if (!status) return "能力状态未知。";
  if (status.support === "unsupported") return status.reason ?? "Engine 不支持此操作。";
  if (status.support === "unknown") return status.reason ?? "Engine 支持情况未知。";
  if (status.availability === "authorization-required") return status.reason ?? "当前授权不足。";
  if (status.availability === "temporarily-unavailable") return status.reason ?? "此能力暂不可用。";
  if (status.availability === "unknown") return status.reason ?? "此能力当前是否可用未知。";
  return null;
}

export function capabilityPillClass(status: CapabilityState | undefined): string {
  if (!status || status.support === "unknown" || status.availability === "unknown") {
    return "border-warning/30 bg-warning/10 text-warning";
  }
  if (status.support === "unsupported") return "border-border bg-surface text-foreground-subtle";
  if (status.availability === "available") return "border-success/30 bg-success/10 text-success";
  return "border-warning/30 bg-warning/10 text-warning";
}

export function currentEngineStatusLabel(engine: CurrentEngine | undefined): string {
  if (!engine || engine.state === "unknown") return "当前状态未知";
  return engine.source === "active-probe" ? "当前已探测" : "当前状态未知";
}

export function EngineCapabilityList({
  engine,
  compact = false,
}: {
  engine: CurrentEngine;
  compact?: boolean;
}) {
  return (
    <div>
      <p className="mb-2 text-[10px] text-foreground-subtle">
        {currentEngineStatusLabel(engine)}
        {engine.observedAt === null ? "" : ` · ${timeLabel(engine.observedAt)}`}
      </p>
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
              <span className="flex items-center justify-between gap-2 text-foreground">
                {label}
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${capabilityPillClass(capability)}`}
                >
                  {capabilityLabel(engine.state === "current" ? capability : undefined)}
                </span>
              </span>
              {capability?.reason ? (
                <span className="text-foreground-subtle">{capability.reason}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
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

export function canActOnTask(task: EngineTask, capability: CapabilityName): string | null {
  if (capability !== "execution.interrupt") {
    if (task.status !== "active")
      return `Task 当前状态为“${taskStatusLabel(task.status)}”，不接收新的业务请求。`;
    if (task.session.status !== "active")
      return `产品 Session 当前状态为“${sessionStatusLabel(task.session.status)}”。`;
  }
  if (task.currentEngine.state !== "current") return "Engine 当前能力未知，请刷新状态后重试。";
  const { engine, currentEngine } = task;
  const mismatch =
    engine.adapterVersion !== currentEngine.adapterVersion ||
    engine.configurationVersion !== currentEngine.configurationVersion ||
    engine.environment !== currentEngine.environment;
  if (mismatch) {
    return "Engine 配置、适配器或环境与创建时快照不同；请重新创建 Task 并重新授权后操作。";
  }
  return capabilityBlockReason(currentEngine.capabilities[capability]);
}
