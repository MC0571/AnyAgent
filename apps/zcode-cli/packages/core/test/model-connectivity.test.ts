import assert from "node:assert/strict";
import { test } from "node:test";
import { createRootTraceContext } from "@zcode/contracts";
import { testModelConnectivity } from "../src/runtime/methods/workspace-generate-text.js";

for (const finishReason of ["stop", "length"] as const) {
  test(`connectivity probe ${finishReason}`, async () => {
    let maxOutputTokens: number | undefined;
    const model = {
      providerId: "test",
      modelId: "model",
      properties: {},
      optionSpecs: { reasoningLevel: { values: ["low"] } },
      options: {},
      bind(options: { maxOutputTokens?: number }) {
        maxOutputTokens = options.maxOutputTokens;
        return this;
      },
      async *streamText() {
        yield { type: "finish", finishReason, usage: {} };
      },
    };
    const runtime = {
      config: {},
      rootTraceContext: createRootTraceContext(),
      modelFactory: () => model,
      createModelStatusSink: () => ({ publish() {} }),
    };
    const probe = testModelConnectivity.call(runtime as never, {
      selection: { providerId: "test", modelId: "model" },
    });
    if (finishReason === "stop") await probe;
    else await assert.rejects(probe, /未正常结束：length/);
    assert.equal(maxOutputTokens, 16);
  });
}
