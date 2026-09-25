import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Emitter } from "@zcode/rpc";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentTransferProgress,
} from "./promptAttachmentTransfer.js";

/** 本地 workspace 保持 localPath 零拷贝，不伪造上传进度。 */
export function createLocalPromptAttachmentTransferService(): IPromptAttachmentTransferService {
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  return {
    async stage(params) {
      if (!isAbsolute(params.localPath) || params.localPath.includes("\0"))
        throw new Error("附件必须是 Host 可读取的本地绝对路径。");
      const file = await stat(params.localPath);
      if (!file.isFile()) throw new Error("所选附件必须是普通文件。");
      return {
        operationId: params.operationId,
        ref: params.localPath,
        // Renderer-provided size can be stale or forged; Host metadata comes from the file itself.
        bytes: file.size,
        staged: false,
      };
    },
    async adopt() {},
    async cancel() {},
    async cleanup() {},
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
