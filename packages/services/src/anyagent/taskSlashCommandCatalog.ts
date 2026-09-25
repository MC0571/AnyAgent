import { RuntimeEligibilityError, type TaskRuntime } from "@anyagent/runtime";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
} from "../zcode-agent/zcodeAgent.js";
import type { IAnyAgentService } from "./anyAgentService.js";

export function createTaskSlashCommandCatalogReader(
  runtime: Pick<TaskRuntime, "readQualifiedTaskSession">,
  agent: Pick<IZCodeAgentService, "readWorkspacePresentation">,
): Pick<IAnyAgentService, "getTaskSlashCommandCatalog"> {
  return {
    getTaskSlashCommandCatalog: async (input) => {
      const presentation = await runtime.readQualifiedTaskSession(input, async (target) => {
        if (target.engineId !== "zcode")
          throw new RuntimeEligibilityError(
            "CLI slash command catalogs are available only for ZCode Tasks.",
            "unsupported",
          );
        const workspacePath = target.environment.workDirectory;
        if (target.environment.kind !== "workspace" || !workspacePath)
          throw new RuntimeEligibilityError(
            "The Task does not have a readable workspace for its CLI slash command catalog.",
            "unsupported",
          );
        let current: Awaited<ReturnType<IZCodeAgentService["readWorkspacePresentation"]>>;
        try {
          current = await agent.readWorkspacePresentation({
            workspacePath,
            runtimePolicy: "existing-only",
          });
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
          )
            throw new RuntimeEligibilityError(
              "The current ZCode Agent runtime is temporarily unavailable.",
              "temporarily-unavailable",
            );
          throw error;
        }
        if (current.workspace.workspacePath !== workspacePath)
          throw new RuntimeEligibilityError(
            "The native Engine returned a slash command catalog for another workspace.",
            "ownership",
          );
        return current;
      });
      return {
        slashCommands: presentation.slashCommands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.inputHint === undefined ? {} : { inputHint: command.inputHint }),
          ...(command.source === undefined ? {} : { source: command.source }),
        })),
      };
    },
  };
}
