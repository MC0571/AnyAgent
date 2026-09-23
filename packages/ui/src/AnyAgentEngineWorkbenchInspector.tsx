import {
  jsonLabel,
  provenanceLabel,
  recordStatusLabel,
  sessionStatusLabel,
  shortId,
  timeLabel,
  WorkbenchCapabilityList,
  type WorkbenchApproval,
  type WorkbenchHistory,
  type WorkbenchTask,
  type WorkbenchUserInput,
} from "./AnyAgentEngineWorkbenchParts.js";

export function AnyAgentEngineWorkbenchInspector({
  task,
  history,
  approvalBlock,
  userInputBlock,
  busyAction,
  userInputDrafts,
  onUserInputDraftChange,
  onReplyApproval,
  onReplyUserInput,
}: {
  task: WorkbenchTask;
  history: WorkbenchHistory | null;
  approvalBlock: string | null;
  userInputBlock: string | null;
  busyAction: string | null;
  userInputDrafts: Record<string, string>;
  onUserInputDraftChange: (requestId: string, value: string) => void;
  onReplyApproval: (approval: WorkbenchApproval, optionId: string) => void;
  onReplyUserInput: (request: WorkbenchUserInput, response: unknown) => void;
}) {
  const latestExecution = history?.executions[history.executions.length - 1];
  return (
    <aside className="min-h-0 overflow-y-auto border-l border-slate-200 bg-white p-4">
      <section>
        <h3 className="mb-2 text-sm font-semibold">产品归属</h3>
        <dl className="space-y-2 text-xs">
          <InfoRow label="Task" value={task.id} />
          <InfoRow label="参与者" value={`${task.participant.id} · ${task.participant.status}`} />
          <InfoRow
            label="产品 Session"
            value={`${task.session.id} · ${sessionStatusLabel(task.session.status)}`}
          />
          <InfoRow
            label="当前 Execution"
            value={
              latestExecution
                ? `${latestExecution.id} · ${recordStatusLabel(latestExecution.status)}`
                : "尚未创建"
            }
          />
          <InfoRow
            label="Engine"
            value={`${task.engine.engineId} · ${task.engine.adapterVersion}`}
          />
          <InfoRow label="工作目录" value={task.environment.workDirectory ?? "未知"} />
          <InfoRow
            label="环境"
            value={`${task.environment.label ?? task.environment.id} · ${task.environment.kind}`}
          />
          <InfoRow label="环境来源" value={provenanceLabel(task.environment.provenance)} />
          <InfoRow
            label="凭据来源"
            value={`${task.credentialSource.label ?? task.credentialSource.kind} · ${provenanceLabel(task.credentialSource.provenance)}`}
          />
        </dl>
      </section>

      <section className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold">Engine 能力</h3>
        <WorkbenchCapabilityList engine={task.engine} />
      </section>

      <section className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold">审批答复</h3>
        <div className="space-y-2">
          {(history?.approvals ?? []).map((approval) => (
            <div key={approval.id} className="rounded-md border border-slate-200 p-2">
              <div className="text-xs font-medium">
                {approval.operation} · {recordStatusLabel(approval.status)}
              </div>
              {approval.scope ? (
                <div className="mt-1 text-xs text-slate-500">范围：{approval.scope}</div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1">
                {approval.status === "pending" ? (
                  approval.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
                      disabled={!!approvalBlock || busyAction !== null}
                      title={approvalBlock ?? undefined}
                      onClick={() => onReplyApproval(approval, option.id)}
                    >
                      {option.label}
                    </button>
                  ))
                ) : (
                  <span className="text-xs text-slate-500">
                    {approval.repliedOptionId
                      ? `答复选项：${approval.repliedOptionId}`
                      : "无待处理答复"}
                  </span>
                )}
              </div>
            </div>
          ))}
          {!history?.approvals.length ? (
            <p className="text-xs text-slate-500">无审批请求。</p>
          ) : null}
          {approvalBlock && history?.approvals.some((item) => item.status === "pending") ? (
            <p className="text-xs text-amber-800">{approvalBlock}</p>
          ) : null}
        </div>
      </section>

      <section className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold">独立用户输入</h3>
        <div className="space-y-2">
          {(history?.userInputs ?? []).map((request) => (
            <div key={request.id} className="rounded-md border border-slate-200 p-2">
              <div className="text-xs font-medium">
                {request.inputKind} · {recordStatusLabel(request.status)}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{request.prompt}</p>
              {request.status === "pending" ? (
                <div className="mt-2 space-y-2">
                  {request.inputKind === "choice" ? (
                    <div className="flex flex-wrap gap-1">
                      {request.options.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
                          disabled={!!userInputBlock || busyAction !== null}
                          title={userInputBlock ?? undefined}
                          onClick={() => onReplyUserInput(request, option.id)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <form
                      className="space-y-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const response = userInputDrafts[request.id]?.trim();
                        if (response) onReplyUserInput(request, response);
                      }}
                    >
                      <textarea
                        aria-label="用户输入答复"
                        className="min-h-16 w-full resize-y rounded border border-slate-300 px-2 py-1 text-sm"
                        value={userInputDrafts[request.id] ?? ""}
                        onChange={(event) => onUserInputDraftChange(request.id, event.target.value)}
                      />
                      <button
                        type="submit"
                        className="rounded bg-slate-800 px-2 py-1 text-xs text-white disabled:opacity-40"
                        disabled={!!userInputBlock || busyAction !== null}
                      >
                        提交用户输入
                      </button>
                    </form>
                  )}
                  {userInputBlock ? (
                    <p className="text-xs text-amber-800">{userInputBlock}</p>
                  ) : null}
                </div>
              ) : request.response != null ? (
                <pre className="mt-2 overflow-auto rounded bg-slate-50 p-2 text-xs">
                  {jsonLabel(request.response)}
                </pre>
              ) : null}
            </div>
          ))}
          {!history?.userInputs.length ? (
            <p className="text-xs text-slate-500">无用户输入请求。</p>
          ) : null}
        </div>
      </section>

      <section className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold">停止与核对</h3>
        <div className="space-y-2">
          {(history?.stopRequests ?? []).map((stop) => (
            <div
              key={stop.id}
              className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs"
            >
              {recordStatusLabel(stop.status)} · Execution {shortId(stop.executionId)} ·{" "}
              {timeLabel(stop.requestedAt)}
              {stop.reason ? <div className="mt-1">{stop.reason}</div> : null}
            </div>
          ))}
          {(history?.integrityIssues ?? []).map((issue) => (
            <div
              key={issue.id}
              className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900"
            >
              {issue.type} · {timeLabel(issue.occurredAt)}
              <div className="mt-1">{issue.detail}</div>
            </div>
          ))}
          {!history?.stopRequests.length && !history?.integrityIssues.length ? (
            <p className="text-xs text-slate-500">无停止请求或待核对事项。</p>
          ) : null}
        </div>
      </section>
    </aside>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-all font-medium text-slate-800">{value}</dd>
    </div>
  );
}
