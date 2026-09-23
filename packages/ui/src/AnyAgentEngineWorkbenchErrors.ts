export type WorkbenchNotice = { kind: "info" | "warning" | "error"; message: string };

export function runtimeErrorNotice(error: unknown): WorkbenchNotice {
  const errorObject =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const failure = errorObject?.failure;
  const failureObject =
    typeof failure === "object" && failure !== null ? (failure as Record<string, unknown>) : null;
  const rawKind = [failureObject?.kind, errorObject?.kind, errorObject?.code].find(
    (value): value is string => typeof value === "string",
  );
  const kind = rawKind?.toLowerCase().replaceAll("_", "-");
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "服务未返回可读详情";
  const normalizedMessage = message.toLowerCase().replaceAll("_", "-");
  const inferredKind =
    kind ??
    (normalizedMessage.includes("authorization") || normalizedMessage.includes("scope")
      ? "authorization-required"
      : normalizedMessage.includes("unsupported")
        ? "unsupported"
        : normalizedMessage.includes("temporarily-unavailable")
          ? "temporarily-unavailable"
          : null);
  switch (inferredKind) {
    case "unsupported":
      return { kind: "warning", message: `不支持：${message}` };
    case "temporarily-unavailable":
      return { kind: "warning", message: `暂不可用：${message}` };
    case "authorization-required":
      return { kind: "warning", message: `授权不足：${message}` };
    case "execution-failed":
      return { kind: "error", message: `执行方已报告失败：${message}` };
    case "result-unknown":
    case "unknown":
      return { kind: "warning", message: `结果未知：${message}` };
    default:
      return { kind: "warning", message: `请求尚未得到确认：${message}` };
  }
}
