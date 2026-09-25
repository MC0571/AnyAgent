export interface ImportedEngineTaskNavigationRequest {
  readonly taskId: string;
  readonly workspacePath: string;
}

let pendingRequest: ImportedEngineTaskNavigationRequest | null = null;
const listeners = new Set<() => void>();

export function requestImportedEngineTaskNavigation(
  request: ImportedEngineTaskNavigationRequest,
): void {
  pendingRequest = request;
  for (const listener of listeners) listener();
}

export function consumeImportedEngineTaskNavigationRequest(
  workspacePath: string,
): ImportedEngineTaskNavigationRequest | null {
  if (!pendingRequest || pendingRequest.workspacePath !== workspacePath) return null;
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

export function subscribeImportedEngineTaskNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
