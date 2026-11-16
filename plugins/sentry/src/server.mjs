// Starts Sentry's own MCP server (the code behind mcp.sentry.dev) with route.mjs deciding where its API calls go.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const bin = join(dirname(createRequire(import.meta.url).resolve("@sentry/mcp-server/package.json")), "dist", "sentry-mcp.cjs");

export async function startSentryServer({ mode, token, copy, log }) {
  const home = mkdtempSync(join(tmpdir(), "phoenix-sentry-"));
  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH ?? "", HOME: home, SENTRY_CONFIG_DIR: join(home, ".sentry"), SENTRY_AUTH_TOKEN: token, TZ: process.env.TZ ?? "UTC",
      SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1",
      NODE_OPTIONS: `--import ${join(import.meta.dirname, "route.mjs")}`, PHOENIX_SENTRY_MODE: mode,
      ...(copy ? { PHOENIX_SENTRY_COPY: copy } : {}), ...(log ? { PHOENIX_SENTRY_LOG: log } : {}),
    },
  });
  const pending = new Map();
  let next = 0;
  const closed = new Promise(resolve => child.once("close", resolve)).then(() => {
    for (const { reject } of pending.values()) reject(new Error("Sentry's MCP server exited"));
  });
  createInterface({ input: child.stdout }).on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id).resolve(message); pending.delete(message.id); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
  const started = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phoenix-sentry", version: "1" } });
  if (started.error) throw new Error(`Sentry's MCP server did not start: ${started.error.message}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    initialized: started.result,
    request,
    async close() {
      child.stdin.end();
      child.kill("SIGTERM");
      await closed;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
