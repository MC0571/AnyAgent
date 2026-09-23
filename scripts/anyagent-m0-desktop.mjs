import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("M0 desktop is supported on macOS Apple Silicon only");
}

const root = resolve(import.meta.dirname, "..");
const data = join(root, ".anyagent-runtime");
const home = join(data, "home");
const electron = join(data, "electron");
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(electron, { recursive: true, mode: 0o700 });

const inherited = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME"];
const env = Object.fromEntries(inherited.flatMap((name) =>
  process.env[name] === undefined ? [] : [[name, process.env[name]]]
));
Object.assign(env, {
  HOME: home,
  ANYAGENT_M0: "1",
  ZCODE_ENV: "production",
  ZCODE_PREVIEW_IDENTITY: "1",
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_HOME: join(home, ".zcode"),
  ZCODE_STORAGE_DIR: join(home, ".zcode"),
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: electron,
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(electron, "session"),
  ZCODE_DESKTOP_APPLICATION_NAME: "AnyAgent Dev",
  ZCODE_BASE_URL: "http://127.0.0.1:9",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
});

const child = spawn("pnpm", process.argv.includes("--bootstrap") ? ["bootstrap"] : ["dev:desktop:prod"], {
  cwd: root,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
