import assert from "node:assert/strict";
import { createServer } from "node:http";
import { open, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const HOST = "127.0.0.1";
const COMPLETIONS_PATH = "/v1/chat/completions";
const DEFAULT_PORT = 8765;
const CHUNK_DELAY_MS = 220;
const MAX_REQUEST_BYTES = 1024 * 1024;

const usage = `Usage:
  node scripts/m1-loopback-provider.mjs --log-file <path> [--port <port>] [--delay-ms <ms>]
  node scripts/m1-loopback-provider.mjs --smoke

Environment defaults: ANYAGENT_M1_LOOPBACK_PORT, ANYAGENT_M1_LOOPBACK_LOG_FILE`;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseDelay(value) {
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 0 || delay > 10_000) {
    throw new Error(`Invalid delay: ${value}`);
  }
  return delay;
}

function parseArgs(args) {
  const options = {
    port: parsePort(process.env.ANYAGENT_M1_LOOPBACK_PORT ?? DEFAULT_PORT),
    delayMs: CHUNK_DELAY_MS,
    logFile: process.env.ANYAGENT_M1_LOOPBACK_LOG_FILE?.trim() || undefined,
    smoke: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--smoke") options.smoke = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--port" || arg === "--log-file" || arg === "--delay-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--port") options.port = parsePort(value);
      else if (arg === "--delay-ms") options.delayMs = parseDelay(value);
      else options.logFile = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function chunksFor(ordinal) {
  return [
    `M1-R${ordinal}-START\n\nStreaming fixture:\n\n`,
    `\`\`\`ts\nconst round = ${ordinal};\n`,
    `\`\`\`\n\nM1-R${ordinal}-END`,
  ];
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, HOST, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve listening port");
  return address.port;
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function startFixture({ port, logFile, delayMs = CHUNK_DELAY_MS }) {
  const resolvedLogFile = resolve(logFile);
  await mkdir(dirname(resolvedLogFile), { recursive: true, mode: 0o700 });
  const log = await open(resolvedLogFile, "a", 0o600);
  let logWrites = Promise.resolve();
  let requestOrdinal = 0;
  let closed = false;

  function record(event, fields = {}) {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...fields,
    })}\n`;
    logWrites = logWrites.then(() => log.write(line));
    return logWrites;
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (request.method !== "POST" || pathname !== COMPLETIONS_PATH) {
      writeJson(response, 404, { error: "Use POST /v1/chat/completions" });
      return;
    }

    const ordinal = ++requestOrdinal;
    void (async () => {
      let body;
      try {
        body = await readRequestBody(request);
      } catch {
        await record("request-rejected", { ordinal, reason: "invalid-or-large-json" });
        writeJson(response, 400, { error: "Expected a JSON Chat Completions request" });
        return;
      }

      const model =
        typeof body?.model === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(body.model)
          ? body.model
          : "m1-loopback";
      if (!Array.isArray(body?.messages)) {
        await record("request-rejected", { ordinal, reason: "messages-required" });
        writeJson(response, 400, { error: "Expected a messages array" });
        return;
      }

      const messages = body.messages;
      if (body.stream !== true) {
        await record("nonstream-request", { ordinal, model, messageCount: messages.length });
        writeJson(response, 200, {
          id: `chatcmpl-m1-${ordinal}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: chunksFor(ordinal).join("") },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
        });
        return;
      }
      await record("request", {
        ordinal,
        method: request.method,
        path: pathname,
        model,
        stream: true,
        messageCount: messages.length,
        userMessageCount: messages.filter((message) => message?.role === "user").length,
      });

      const id = `chatcmpl-m1-${ordinal}`;
      const created = Math.floor(Date.now() / 1000);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.flushHeaders();

      const chunks = chunksFor(ordinal);
      for (let index = 0; index < chunks.length; index += 1) {
        if (response.destroyed) {
          await record("client-disconnected", { ordinal, chunk: index + 1 });
          return;
        }
        const content = chunks[index];
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        );
        await record("delta", {
          ordinal,
          chunk: index + 1,
          label: ["opening", "code", "closing"][index],
        });
        if (index < chunks.length - 1)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }

      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      await record("completed", { ordinal, finishReason: "stop", chunkCount: chunks.length });
    })().catch(async () => {
      await record("request-failed", { ordinal, reason: "fixture-write-failed" }).catch(() => {});
      if (!response.destroyed && !response.headersSent) {
        writeJson(response, 500, { error: "Loopback fixture failed" });
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });

  const selectedPort = await listen(server, port).catch(async (error) => {
    await log.close();
    throw error;
  });
  await record("ready", { host: HOST, port: selectedPort });

  return {
    logFile: resolvedLogFile,
    port: selectedPort,
    url: `http://${HOST}:${selectedPort}/v1`,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await record("stopped", { requestCount: requestOrdinal });
      await logWrites;
      await log.close();
    },
  };
}

function parseSseFrame(frame) {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  return data === "[DONE]" ? data : JSON.parse(data);
}

async function readSse(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  assert.ok(response.body, "SSE response has a body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const parsed = parseSseFrame(frame);
      if (parsed !== undefined) frames.push({ event: parsed, receivedAt: Date.now() });
      boundary = pending.indexOf("\n\n");
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const parsed = parseSseFrame(pending);
    if (parsed !== undefined) frames.push({ event: parsed, receivedAt: Date.now() });
  }
  return frames;
}

async function runSmoke() {
  const temporaryDir = await mkdtemp(join(tmpdir(), "anyagent-m1-loopback-"));
  const logFile = join(temporaryDir, "fixture.jsonl");
  let fixture;
  try {
    fixture = await startFixture({ port: 0, logFile });
    const sentinel = "SMOKE_PRIVATE_PROMPT_SENTINEL";
    const results = [];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const response = await fetch(`${fixture.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer SMOKE_DUMMY_KEY",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "m1-loopback",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: `${sentinel}-${ordinal}` }],
        }),
      });
      const frames = await readSse(response);
      const contentFrames = frames.filter(
        ({ event }) =>
          typeof event === "object" && typeof event.choices?.[0]?.delta?.content === "string",
      );
      const chunks = contentFrames.map(({ event }) => event.choices[0].delta.content);
      const content = chunks.join("");
      assert.equal(chunks.length, 3, "response arrives as three content chunks");
      assert.match(content, new RegExp(`M1-R${ordinal}-START`, "u"));
      assert.match(content, new RegExp(`M1-R${ordinal}-END`, "u"));
      assert.match(content, new RegExp(`const round = ${ordinal};`, "u"));
      assert.ok(
        content.includes(`Streaming fixture:\n\n\`\`\`ts\nconst round = ${ordinal};\n\`\`\``),
        "code fence remains a standalone Markdown block across chunks",
      );
      assert.ok(
        contentFrames.at(-1).receivedAt - contentFrames[0].receivedAt >= CHUNK_DELAY_MS,
        "content fragments arrive before completion with the configured delay",
      );
      assert.equal(frames.at(-1).event, "[DONE]", "SSE stream ends with [DONE]");
      results.push(content);
    }

    assert.notEqual(results[0], results[1], "round responses are distinct");
    const nonstream = await fetch(`${fixture.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m1-loopback",
        messages: [{ role: "user", content: "probe" }],
      }),
    });
    assert.equal(nonstream.status, 200);
    assert.match((await nonstream.json()).choices[0].message.content, /M1-R3-START/u);
    await fixture.close();
    const logText = await readFile(logFile, "utf8");
    assert.doesNotMatch(logText, /SMOKE_PRIVATE_PROMPT_SENTINEL|SMOKE_DUMMY_KEY/u);
    const entries = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.filter((entry) => entry.event === "request").map((entry) => entry.ordinal),
      [1, 2],
    );
    assert.equal(entries.filter((entry) => entry.event === "delta").length, 6);
    console.log(
      `M1_LOOPBACK_SMOKE_OK port=${fixture.port} requests=2 delayed_chunks=6 redacted_log=true`,
    );
  } finally {
    if (fixture) await fixture.close();
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.smoke) {
    if (process.argv.slice(2).some((arg) => arg !== "--smoke")) {
      throw new Error("--smoke does not accept other options");
    }
    await runSmoke();
    return;
  }
  if (!options.logFile) throw new Error("Provide --log-file or ANYAGENT_M1_LOOPBACK_LOG_FILE");

  const fixture = await startFixture({
    port: options.port,
    logFile: options.logFile,
    delayMs: options.delayMs,
  });
  console.log(`M1_LOOPBACK_READY url=${fixture.url} port=${fixture.port} log=${fixture.logFile}`);
  const shutdown = () => {
    void fixture.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (process.argv.includes("--help") || process.argv.includes("-h")) return;
  console.error(usage);
  process.exitCode = 1;
});
