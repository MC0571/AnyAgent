import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalPromptAttachmentTransferService } from "../src/prompt-attachment-transfer/promptAttachmentTransferService.js";

test("local attachment staging verifies the selected file and derives its actual size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prompt-attachment-stage-"));
  const path = join(directory, "selected.md");
  await writeFile(path, "host-measured-size");
  const service = createLocalPromptAttachmentTransferService();
  try {
    const result = await service.stage({
      operationId: "stage-one",
      sessionId: "native-session",
      workspacePath: directory,
      localPath: path,
      fileName: "selected.md",
      mime: "text/markdown",
      sizeBytes: 1,
    });
    assert.deepEqual(result, {
      operationId: "stage-one",
      ref: path,
      bytes: Buffer.byteLength("host-measured-size"),
      staged: false,
    });
    await assert.rejects(
      service.stage({
        operationId: "stage-directory",
        sessionId: "native-session",
        workspacePath: directory,
        localPath: directory,
        fileName: "directory",
        mime: "application/octet-stream",
      }),
      /普通文件/u,
    );
    await assert.rejects(
      service.stage({
        operationId: "stage-relative",
        sessionId: "native-session",
        workspacePath: directory,
        localPath: "selected.md",
        fileName: "selected.md",
        mime: "text/markdown",
      }),
      /本地绝对路径/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
