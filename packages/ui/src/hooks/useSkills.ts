import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillScope, ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import type { TaskSkillReference, TaskSkillReferenceCatalogRequest } from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface ComposerSkillReference {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  enabled: true;
  pluginName?: string;
}

interface ConversationSkillCatalogState {
  skills: ComposerSkillReference[];
  authority: "session" | "workspace" | null;
  hostTaskScoped: boolean;
  loading: boolean;
  error: string | null;
}

interface ScopedConversationSkillCatalogState {
  scope: object | null;
  value: ConversationSkillCatalogState;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  hostTaskScoped: false,
  loading: false,
  error: null,
};

const EMPTY_SCOPED_STATE: ScopedConversationSkillCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string;
  taskCatalogRequest?: TaskSkillReferenceCatalogRequest;
}

function mapNativeSkillReference(skill: ZCodeSkillReferenceCatalogEntry): ComposerSkillReference {
  return skill;
}

function mapTaskSkillReference(
  skill: TaskSkillReference,
  taskId: string,
): ComposerSkillReference {
  return {
    id: `task-skill:${taskId}:${skill.name}`,
    name: skill.name,
    description: skill.description,
    path: "",
    scope: skill.scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}

/**
 * Composer 的 Skill catalog。
 * 无 prewarm 的 draft 以 workspace 当前扫描为 authority；prewarm/已有 Session 以对应
 * AgentRuntime 冻结快照为 authority。workspace/session/remote attachment/runtime 代次变化时，
 * 旧异步结果一律不得回填。
 */
export function useSkills(options: UseSkillsOptions): ConversationSkillCatalogState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.preferredRemoteSessionId,
    options.workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedConversationSkillCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options.preferredRemoteSessionId ?? undefined;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const taskRequest = options.taskCatalogRequest;
  const taskId = taskRequest?.taskId;
  const participantId = taskRequest?.participantId;
  const productSessionId = taskRequest?.sessionId;
  const authorizationId = taskRequest?.authorizationId;
  const usesHostTaskCatalog = taskRequest !== undefined;
  const hasTaskRequest = Boolean(taskId && participantId && productSessionId && authorizationId);
  const taskIdentityKey = usesHostTaskCatalog
    ? `${taskId}|${participantId}|${productSessionId}`
    : "native";
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${options.sessionId ?? "draft"}|${taskIdentityKey}|runtime:${runtimeRevision}`;

  useEffect(() => {
    if (!options.enabled || !options.sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // runtime 重建后 workspace/session key 不变，旧 catalog 会继续命中。
      // 显式推进代次，使冷恢复后的新 runtime 必须重新提供一次 Session authority。
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [options.enabled, options.sessionId, rpcReady, services, workspaceKey]);

  // 用 scope 身份隔离渲染：key 切换后的 effect 尚未执行时也只返回空态，避免旧 Session
  // 或旧 remote attachment 的 Skill 在一帧内泄漏到新 Composer。
  const requestScope = useMemo(
    () => ({}),
    [authorizationId, options.enabled, remoteSessionId, requestKey, rpcReady, services],
  );

  useEffect(() => {
    if (!options.enabled || !options.workspacePath || !rpcReady) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: {
        skills: [],
        authority: null,
        hostTaskScoped: usesHostTaskCatalog,
        loading: true,
        error: null,
      },
    });
    const readCatalog = async (): Promise<ConversationSkillCatalogState> => {
      if (usesHostTaskCatalog) {
        if (!hasTaskRequest) throw new Error("当前 Task 的 Skill 目录身份不完整。");
        if (!services.anyAgentService) throw new Error("当前 Task 的 Skill 目录服务不可用。");
        const catalog = await services.anyAgentService.getTaskSkillReferenceCatalog({
          taskId: taskId!,
          participantId: participantId!,
          sessionId: productSessionId!,
          authorizationId: authorizationId!,
        });
        return {
          skills: catalog.skills.map((skill) => mapTaskSkillReference(skill, taskId!)),
          authority: "session",
          hostTaskScoped: true,
          loading: false,
          error: null,
        };
      }
      const catalog = await services.zcodeAgentService.getSkillReferenceCatalog({
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
      return {
        skills: catalog.skills.map(mapNativeSkillReference),
        authority: catalog.authority,
        hostTaskScoped: false,
        loading: false,
        error: null,
      };
    };
    void readCatalog()
      .then((catalog) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: catalog,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useSkills] 拉取对话 Skill catalog 失败", {
          error: message,
          requestKey,
        });
        setScopedState({
          scope: requestScope,
          value: {
            skills: [],
            authority: null,
            hostTaskScoped: usesHostTaskCatalog,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    taskId,
    participantId,
    productSessionId,
    authorizationId,
    hasTaskRequest,
    usesHostTaskCatalog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
  ]);

  if (
    !options.enabled ||
    !options.workspacePath ||
    !rpcReady ||
    scopedState.scope !== requestScope
  ) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
