// Runs the sentry command line (0.44.1, this plugin's dependency) in a home of its own, with route.mjs deciding where
// its Sentry API calls go: to the copy in a replay, or to the real Sentry with GET only when a mark reads it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const bin = join(dirname(createRequire(import.meta.url).resolve("sentry")), "bin.cjs");

export function runCli(argv, { stdin = "", cwd, token, mode, copy, log }) {
  const home = mkdtempSync(join(tmpdir(), "phoenix-sentry-cli-"));
  const child = spawn(process.execPath, [bin, ...argv], {
    cwd: cwd ?? home,
    env: {
      PATH: process.env.PATH ?? "", HOME: home, SENTRY_CONFIG_DIR: join(home, ".sentry"), SENTRY_AUTH_TOKEN: token, ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      SENTRY_NO_CACHE: "1", SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1",
      NODE_OPTIONS: `--import ${join(import.meta.dirname, "route.mjs")}`, PHOENIX_SENTRY_MODE: mode,
      ...(copy ? { PHOENIX_SENTRY_COPY: copy } : {}), ...(log ? { PHOENIX_SENTRY_LOG: log } : {}),
    },
  });
  const out = [], err = [];
  child.stdout.on("data", chunk => out.push(chunk));
  child.stderr.on("data", chunk => err.push(chunk));
  child.stdin.end(stdin);
  return new Promise(resolve => child.once("close", code => { rmSync(home, { recursive: true, force: true }); resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 }); }));
}
