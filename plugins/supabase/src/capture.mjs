// Plans the moment's read-only snapshot from the session's own Supabase calls (spec/plugin.md, capture orchestration).
// It repeats every read the session made, reads the lists a later call may need, and asks the snapshot server for the
// database's structure and the rows of the tables the session's SQL named. The host makes these reads; this sidecar
// makes no network calls.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { tablesIn } from "./dump.mjs";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
const LISTS = [
  ["tools/call:list_tables", { schemas: [], verbose: true }], ["tools/call:list_extensions", {}], ["tools/call:list_migrations", {}],
  ["tools/call:get_advisors", { type: "security" }], ["tools/call:get_advisors", { type: "performance" }], ["tools/call:get_advisors", { type: "health" }], ["tools/call:get_project_url", {}],
  ["tools/call:get_publishable_keys", {}], ["tools/call:generate_typescript_types", {}], ["tools/call:list_edge_functions", {}],
  ["tools/call:list_branches", {}], ["tools/call:list_notebooks", {}],
];
let calls = [];
let initialized = false;

async function plan(segments) {
  const events = [];
  for (const segment of segments) {
    for (const line of (await readFile(segment, "utf8")).split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.connector === descriptor.connector && event.surface === "mcp" && !event.partial && ["call", "result"].includes(event.kind)) events.push({ event, segment });
    }
  }
  events.sort((a, b) => a.event.stream.localeCompare(b.event.stream) || a.event.seq - b.event.seq);
  const reads = new Map();
  const tables = new Set();
  const add = (op, args) => reads.set(JSON.stringify([op, args]), { op, args });
  const pending = new Map();
  for (const { event, segment } of events) {
    if (!event.body || event.body.content_encoding) continue;
    let body = event.body.inline;
    if (event.body.blob) {
      if (!/^sha256:[a-f0-9]{64}$/.test(event.body.blob)) throw new Error("Invalid capture blob reference");
      body = await readFile(join(dirname(segment), "..", "blobs", "sha256", event.body.blob.slice(7)), "utf8");
    }
    let message;
    try { message = JSON.parse(body ?? ""); } catch { continue; }
    if (message?.jsonrpc !== "2.0" || !["string", "number"].includes(typeof message.id)) continue;
    const key = JSON.stringify([event.stream, message.id]);
    if (event.kind === "call") {
      if (message.method !== "tools/call") continue;
      const op = "tools/call:" + message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!descriptor.operations.includes(op) || !args || typeof args !== "object" || Array.isArray(args)) continue;
      pending.set(key, { op, args });
      if (typeof args.query === "string") for (const table of tablesIn(args.query)) tables.add(table);
      continue;
    }
    const call = pending.get(key);
    pending.delete(key);
    if (!call || message.error || !message.result || message.result.isError) continue;
    if (descriptor.read_only.includes(call.op) && call.op !== "tools/call:phoenix_database_snapshot") add(call.op, call.args);
    if (call.op === "tools/call:list_edge_functions") {
      const text = (message.result.content ?? []).map(block => block?.text ?? "").join("\n");
      for (const [, slug] of text.matchAll(/\\?"slug\\?":\s*\\?"([^"\\]+)\\?"/g)) add("tools/call:get_edge_function", { function_slug: slug });
    }
  }
  if (!events.length) return [];
  for (const [op, args] of LISTS) add(op, args);
  return [{ op: "tools/call:phoenix_database_snapshot", args: { schemas: [], tables: [...tables] } }, ...reads.values()];
}

if (import.meta.main) for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
    let value;
    if (request.method === "initialize") {
      const segments = request.params.segments ?? [];
      if (!Array.isArray(segments) || !segments.every(s => typeof s === "string")) throw new Error("segments must be file paths");
      calls = await plan(segments);
      initialized = true;
      value = null;
    } else if (!initialized) throw new Error("Initialize first");
    else if (request.method === "capture" && request.params.phase === "plan") value = { calls };
    else if (request.method === "capture" && request.params.phase === "complete") value = { collections: [{ entity: "row", complete: false }] };
    else {
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "unsupported", reason: "The capture command plans reads; the serve command is the working copy" }));
      continue;
    }
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
  } catch (error) {
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request?.id ?? null, status: "execution-failure", reason: error instanceof Error ? error.message : String(error) }));
  }
}
