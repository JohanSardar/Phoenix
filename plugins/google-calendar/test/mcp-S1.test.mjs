import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const plugin = fileURLToPath(new URL("../", import.meta.url));

test("S1: adapter CLI preserves opaque upstream event fields in reads and moves", async t => {
  const root = await mkdtemp(join(tmpdir(), "phoenix-calendar-S1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);

  const event = {
    id: "deadbeef01", summary: "[phoenix-test] opaque fields",
    start: { dateTime: "2026-11-16T14:00:00-06:00" },
    end: { dateTime: "2026-11-16T14:30:00-06:00" },
    visibility: "private", transparency: "transparent",
    conferenceData: { conferenceId: "fixture-only" }, guestsCanModify: false,
  };
  const upstream = join(root, "upstream.mjs");
  await writeFile(upstream, `import { createInterface } from "node:readline";
let event = ${JSON.stringify(event)};
const defaults = ["id", "summary", "start", "end", "status", "htmlLink", "location", "attendees", "reminders", "recurrence"];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cocal-2.8.1-field-mask-fixture", version: "1" } };
  else if (request.method === "tools/call") {
    const { name, arguments: a } = request.params;
    if (name === "update-event") event = { ...event, start: { dateTime: a.start }, end: { dateTime: a.end } };
    const fields = a.fields ? new Set([...defaults, ...a.fields]) : null;
    const selected = fields ? Object.fromEntries(Object.entries(event).filter(([key]) => fields.has(key))) : event;
    const payload = name === "list-events" ? { events: [selected] } : { event: selected };
    result = { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
  } else result = {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
`);

  const connect = async (command, args) => {
    const client = new Client({ name: "calendar-regression", version: "1" });
    const transport = new StdioClientTransport({ command, args, cwd: root, env: { PATH: process.env.PATH, HOME: home }, stderr: "pipe" });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  };
  const raw = await connect(process.execPath, [upstream]);
  const direct = await raw.callTool({ name: "get-event", arguments: { calendarId: "primary", account: "fixture", eventId: event.id } });
  assert.deepEqual(direct.structuredContent.event, event);

  const adapter = await connect(process.execPath, [join(plugin, "src/mcp.mjs"), "primary", "fixture", process.execPath, upstream]);
  const call = async (name, args) => {
    const result = await adapter.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const listed = await call("list_events", { timeMin: "2026-11-16T00:00:00-06:00", timeMax: "2026-11-17T00:00:00-06:00" });
  const got = await call("get_event", { id: event.id });
  const move = { id: event.id, start: "2026-11-16T15:00:00-06:00", end: "2026-11-16T15:30:00-06:00" };
  const moved = await call("move_event", move);
  assert.deepEqual({ listed, got, moved }, {
    listed: [event], got: event,
    moved: { ...event, start: { dateTime: move.start }, end: { dateTime: move.end } },
  }, "Omitting fields upstream returns these event properties; the adapter must not project them away");
});
