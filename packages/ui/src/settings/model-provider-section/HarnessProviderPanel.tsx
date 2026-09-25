import { useEffect, useState } from "react";
import type { IAnyAgentService } from "@zcode/services";
import { EngineCapabilityList } from "@/EngineUiParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function HarnessProviderPanel({
  service,
  refreshVersion,
}: {
  service: IAnyAgentService;
  refreshVersion: number;
}) {
  const { intl } = useZCodeIntl();
  const [engines, setEngines] = useState<Awaited<
    ReturnType<IAnyAgentService["listEngines"]>
  > | null>(null);
  const [workDirectory, setWorkDirectory] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setEngines(null);
    void Promise.all([service.listEngines(), service.getCreateTaskContext()])
      .then(([nextEngines, context]) => {
        if (!current) return;
        setEngines(nextEngines);
        setWorkDirectory(context.environment.workDirectory ?? "");
        setError("");
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      current = false;
    };
  }, [service, refreshVersion]);

  return (
    <section className="space-y-4" aria-label="Harness">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.harnessTitle" })}
        </h3>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.harnessDescription" })}
        </p>
      </div>
      {workDirectory ? (
        <p className="break-all text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.harnessWorkDirectory" })}：
          {workDirectory}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-base text-destructive">
          {error}
        </p>
      ) : null}
      {engines?.map((engine) => (
        <div key={engine.engineId} className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h4 className="font-semibold text-foreground">{engine.engineId}</h4>
            <span className="text-ui-sm text-foreground-subtle">
              Adapter{" "}
              {engine.adapterVersion ??
                intl.formatMessage({ id: "settings.modelProvider.harnessUnknownVersion" })}{" "}
              · Engine{" "}
              {engine.engineVersion ??
                intl.formatMessage({ id: "settings.modelProvider.harnessUnknownVersion" })}
            </span>
          </div>
          <EngineCapabilityList engine={engine} />
        </div>
      ))}
      {!engines?.length && !error ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: engines ? "settings.modelProvider.harnessEmpty" : "common.loading",
          })}
        </p>
      ) : null}
    </section>
  );
}
