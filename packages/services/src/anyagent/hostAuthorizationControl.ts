import type { RuntimeCurrentAuthorizationProjection, TaskRuntime } from "@anyagent/runtime";

/** Host-only controls, kept outside the renderer-facing IAnyAgentService channel. */
export interface AnyAgentHostAuthorizationControl {
  getAuthorizationStatus(authorizationId: string): RuntimeCurrentAuthorizationProjection;
  revokeAuthorization(
    authorizationId: string,
    reason: string,
  ): RuntimeCurrentAuthorizationProjection;
}

export function createAnyAgentHostAuthorizationControl(
  runtime: TaskRuntime,
): AnyAgentHostAuthorizationControl {
  return {
    getAuthorizationStatus: (authorizationId) =>
      runtime.getHostAuthorizationStatus(authorizationId),
    revokeAuthorization: (authorizationId, reason) =>
      runtime.revokeHostAuthorization(authorizationId, reason),
  };
}
