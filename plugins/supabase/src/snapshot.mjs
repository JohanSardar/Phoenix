#!/usr/bin/env node
// A stdio MCP server for the moment's snapshot. Give it the command that starts Supabase's MCP server the way the
// person's harness does, for example their launcher entry. It runs that command with route.mjs loaded, so SQL is sent
// read-only and every other write is refused before it leaves this machine. Each tool answer carries the API replies
// behind it in _meta. The extra read phoenix_database_snapshot reads the database's structure and the rows of the
// tables a session read, with SELECT statements only.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { takeSnapshot } from "./dump.mjs";
import { connect, route } from "./server.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: phoenix-supabase-snapshot <command that starts Supabase's MCP server> [args...]");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "phoenix-supabase-snapshot-"));
const log = join(scratch, "api.jsonl");
writeFileSync(log, "");
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + route].filter(Boolean).join(" "), PHOENIX_SUPABASE_MODE: "snapshot", PHOENIX_SUPABASE_LOG: log },
});
const server = connect(child, () => { rmSync(scratch, { recursive: true, force: true }); process.exit(0); });
let read = 0;
let flags;
let carry = [];
const fresh = () => {
  const text = readFileSync(log, "utf8");
  const lines = text.slice(read).split("\n").filter(Boolean).map(line => JSON.parse(line));
  read = text.length;
  for (const line of lines) if (line.server) flags = line.server;
  return lines.filter(line => !line.server);
};
const reply = message => process.stdout.write(JSON.stringify(message) + "\n");

async function snapshot(args) {
  carry.push(...fresh());
  const run = async query => {
    const answer = await server.request("tools/call", { name: "execute_sql", arguments: { query } });
    const result = answer.result;
    const text = result?.content?.map(block => block.text ?? "").join("\n") ?? answer.error?.message ?? "";
    if (answer.error || result?.isError) throw new Error("A snapshot read failed: " + text);
    const inner = /<untrusted-data-[\w-]+>\n([\s\S]*)\n<\/untrusted-data-/.exec(JSON.parse(text).result);
    if (!inner) throw new Error("A snapshot read gave an answer Phoenix cannot read");
    return JSON.parse(inner[1]);
  };
  const rowLimit = Number(process.env.PHOENIX_SUPABASE_ROW_LIMIT ?? 1000);
  const database = await takeSnapshot(run, { schemas: Array.isArray(args.schemas) ? args.schemas : [], tables: Array.isArray(args.tables) ? args.tables : [], rowLimit });
  fresh();
  const api = carry;
  carry = [];
  const tables = Object.entries(database.rows).map(([rel, rows]) => rel + " (" + rows.length + " rows)");
  return {
    content: [{ type: "text", text: "Read the structure of " + database.relations.length + " relations and the rows of " + (tables.length ? tables.join(", ") : "no tables") + "." }],
    _meta: { "phoenix/supabase-database": database, "phoenix/supabase-api": api, "phoenix/supabase-server": flags ?? null },
  };
}

async function handle(message) {
  if (message.id === undefined) { if (message.method && message.method !== "notifications/initialized") server.notify(message.method, message.params); return; }
  if (message.method === "tools/call" && message.params?.name === "phoenix_database_snapshot") {
    try { return reply({ jsonrpc: "2.0", id: message.id, result: await snapshot(message.params.arguments ?? {}) }); }
    catch (error) { return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } }); }
  }
  const answer = await server.request(message.method, message.params);
  const { id: _, ...rest } = answer;
  if (message.method === "initialize" && rest.result) { server.notify("notifications/initialized"); await server.request("tools/list", {}); }
  carry.push(...fresh());
  if (message.method === "tools/call" && rest.result) {
    rest.result = { ...rest.result, _meta: { ...rest.result._meta, "phoenix/supabase-api": carry, "phoenix/supabase-server": flags ?? null } };
    carry = [];
  }
  reply({ ...rest, id: message.id });
}

let tail = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  tail = tail.then(() => handle(message)).catch(error => {
    if (message.id !== undefined) reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  });
});
lines.on("close", async () => { await tail; child.stdin.end(); child.kill("SIGTERM"); });
