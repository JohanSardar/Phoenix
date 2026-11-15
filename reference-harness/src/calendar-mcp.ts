import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

type Event = { id: string; title: string; start: string; end: string };
type Request = { id?: string | number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const file = process.env.CALENDAR_FILE ?? ".local/calendar.json";
const tools = JSON.parse(readFileSync("tools/calendar.json", "utf8"));
mkdirSync(dirname(file), { recursive: true });
if (!existsSync(file)) writeFileSync(file, readFileSync("data/calendar.seed.json"));

function call(name: string | undefined, args: Record<string, unknown>) {
  const events: Event[] = JSON.parse(readFileSync(file, "utf8"));
  if (name === "list_events") {
    if (typeof args.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("date must be YYYY-MM-DD");
    return events.filter((event) => event.start.startsWith(args.date as string));
  }
  const event = events.find((event) => event.id === args.id);
  if (!event) throw new Error("Unknown event id");
  if (name === "get_event") return event;
  if (name !== "move_event") throw new Error("Unknown tool");
  const start = args.start;
  const end = args.end;
  if (typeof start !== "string" || typeof end !== "string" ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(start) || !/(Z|[+-]\d{2}:\d{2})$/.test(end) ||
      !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start))
    throw new Error("start and end must be timestamps with time zones, with end after start");
  event.start = start;
  event.end = end;
  writeFileSync(`${file}.tmp`, JSON.stringify(events, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
  return event;
}

for await (const line of createInterface({ input: process.stdin })) {
  let request: Request;
  try {
    request = JSON.parse(line);
  } catch {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }));
    continue;
  }
  if (request.id === undefined) continue;
  let result: object;
  if (request.method === "initialize") {
    result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "local-calendar-demo", version: "1.0.0" } };
  } else if (request.method === "ping") {
    result = {};
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call") {
    try {
      result = { content: [{ type: "text", text: JSON.stringify(call(request.params?.name, request.params?.arguments ?? {})) }] };
    } catch (error) {
      result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Calendar tool failed" }] };
    }
  } else {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
