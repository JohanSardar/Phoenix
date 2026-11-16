#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const [calendarId, account, command, ...args] = process.argv.slice(2);
if (!calendarId || !account || !command) throw new Error("Usage: phoenix-google-calendar-mcp <calendar-id> <account> <upstream-command> [args...]");
const upstream = new Client({ name: "phoenix-google-calendar", version: "1" });
const server = new Server({ name: "phoenix-google-calendar", version: "1" }, { capabilities: { tools: {} } });
const fields = ["description", "created", "updated", "creator", "organizer", "recurrence", "recurringEventId", "originalStartTime", "extendedProperties", "iCalUID", "sequence"];
const tools = [
  { name: "list_events", description: "List events in the configured single calendar within a bounded RFC3339 time window. Results may be incomplete; recurring instances keep their exact ids. No local timezone conversion is performed.", inputSchema: { type: "object", properties: { timeMin: { type: "string" }, timeMax: { type: "string" }, privateExtendedProperty: { type: "array", items: { type: "string" } } }, required: ["timeMin", "timeMax"], additionalProperties: false } },
  { name: "get_event", description: "Read one event by its exact id in the configured calendar, preserving the upstream event fields.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "move_event", description: "Move one non-recurring timed event by exact id. Supply start and end as RFC3339 timestamps with explicit offsets. Other event fields are preserved by PATCH. No invitations or conflict checks are performed. Recurring and all-day writes are unsupported.", inputSchema: { type: "object", properties: { id: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, required: ["id", "start", "end"], additionalProperties: false } }
];

async function read(name, arguments_, key) {
  const result = await upstream.callTool({ name, arguments: { ...arguments_, calendarId, account, fields } });
  if (result.isError) throw new Error(`Upstream ${name} failed`);
  const data = result.structuredContent ?? (result.content?.length === 1 && result.content[0].type === "text" ? JSON.parse(result.content[0].text) : undefined);
  const value = data?.[key];
  if (key === "events" ? !Array.isArray(value) || value.some(event => typeof event?.id !== "string") : typeof value?.id !== "string") throw new Error(`Unexpected ${name} response`);
  return value;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const tool = tools.find(tool => tool.name === request.params.name), a = request.params.arguments ?? {};
    if (!tool || Object.keys(a).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) || tool.inputSchema.required.some(key => typeof a[key] !== "string" || !a[key])) throw new Error("Unsupported tool or arguments");
    if (a.privateExtendedProperty !== undefined && (!Array.isArray(a.privateExtendedProperty) || !a.privateExtendedProperty.every(value => typeof value === "string"))) throw new Error("privateExtendedProperty must be an array of strings");
    let value;
    if (tool.name === "list_events") value = await read("list-events", a, "events");
    else if (tool.name === "get_event") value = await read("get-event", { eventId: a.id }, "event");
    else {
      if (![a.start, a.end].every(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) || Date.parse(a.start) >= Date.parse(a.end)) throw new Error("Move requires an increasing pair of RFC3339 timestamps with offsets");
      const current = await read("get-event", { eventId: a.id }, "event");
      if (current.recurrence || current.recurringEventId || !current.start?.dateTime || !current.end?.dateTime) throw new Error("Recurring and all-day moves are unsupported");
      const result = await upstream.callTool({ name: "update-event", arguments: { calendarId, account, eventId: a.id, start: a.start, end: a.end, sendUpdates: "none", checkConflicts: false } });
      if (result.isError) return result;
      value = await read("get-event", { eventId: a.id }, "event");
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Calendar adapter failed" }] };
  }
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await upstream.close();
  await server.close();
}
server.onclose = () => { void close(); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void close(); });
try {
  await upstream.connect(new StdioClientTransport({ command, args, env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: "inherit" }));
  await server.connect(new StdioServerTransport());
} catch (error) {
  await close();
  throw error;
}
