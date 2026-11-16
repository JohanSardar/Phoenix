// Starts Supabase's own MCP server, with route.mjs deciding where its HTTP requests go, and talks JSON-RPC to it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const route = join(import.meta.dirname, "route.mjs");

export function connect(child, onClose) {
  const pending = new Map();
  let next = 0;
  const closed = new Promise(resolve => child.once("close", resolve)).then(() => {
    for (const { reject } of pending.values()) reject(new Error("Supabase's MCP server exited"));
    onClose?.();
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
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  return { request, notify, closed };
}

export async function startCopyServer({ copy, flags }) {
  const bin = join(dirname(createRequire(import.meta.url).resolve("@supabase/mcp-server-supabase")), "cli.js");
  const home = mkdtempSync(join(tmpdir(), "phoenix-supabase-"));
  const args = [bin, `--project-ref=${flags.project_ref}`, ...(flags.read_only ? ["--read-only"] : []), ...(flags.features ? [`--features=${flags.features}`] : [])];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH ?? "", HOME: home, TZ: process.env.TZ ?? "UTC", SUPABASE_ACCESS_TOKEN: "phoenix-working-copy",
      NODE_OPTIONS: `--import ${route}`, PHOENIX_SUPABASE_MODE: "copy", PHOENIX_SUPABASE_COPY: copy,
      ...(process.env.LD_PRELOAD ? { LD_PRELOAD: process.env.LD_PRELOAD } : {}),
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("FAKETIME"))),
    },
  });
  const rpc = connect(child);
  const started = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phoenix-supabase", version: "1" } });
  if (started.error) throw new Error(`Supabase's MCP server did not start: ${started.error.message}`);
  rpc.notify("notifications/initialized");
  return {
    initialized: started.result,
    request: rpc.request,
    async close() {
      child.stdin.end();
      child.kill("SIGTERM");
      await rpc.closed;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
