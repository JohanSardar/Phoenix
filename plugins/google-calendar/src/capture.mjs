import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
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
  const pending = new Map();
  const reads = new Map();
  const add = call => reads.set(JSON.stringify(call), call);
  // The local server (cocal): read the calendar list, each window it listed or searched in full (a list with `fields` returns
  // only some event fields), and each event named in a call.
  const scope = args => (typeof args.account === "string" ? { account: args.account } : {});
  const cocalCall = (op, args) => {
    if (!/^tools\/call:[a-z]+-[a-z-]+$/.test(op)) return;
    add({ op: "tools/call:list-calendars", args: scope(args) });
    if ((op === "tools/call:list-events" || op === "tools/call:search-events") && typeof args.timeMin === "string" && typeof args.timeMax === "string")
      add({ op: "tools/call:list-events", args: { ...scope(args), calendarId: args.calendarId ?? "primary", timeMin: args.timeMin, timeMax: args.timeMax, ...(typeof args.timeZone === "string" ? { timeZone: args.timeZone } : {}) } });
    if (typeof args.eventId === "string" && args.eventId) add({ op: "tools/call:get-event", args: { ...scope(args), calendarId: typeof args.calendarId === "string" ? args.calendarId : "primary", eventId: args.eventId } });
  };
  const get = id => { if (typeof id === "string" && id) add({ op: "tools/call:get_event", args: { id } }); };
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
      const op = `tools/call:${message.params?.name}`;
      if (!descriptor.operations.includes(op)) continue;
      const args = message.params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      pending.set(key, { op, args });
      get(args.id);
      if (op === "tools/call:list_events") add({ op, args });
      cocalCall(op, args);
      continue;
    }
    const call = pending.get(key);
    pending.delete(key);
    if (!call || message.error || !message.result || message.result.isError) continue;
    const result = message.result;
    let value = result.structuredContent;
    if (value === undefined && result.content?.length === 1 && result.content[0].type === "text") {
      try { value = JSON.parse(result.content[0].text); } catch { continue; }
    }
    for (const entity of Array.isArray(value) ? value : [value]) get(entity?.id);
    if (/^tools\/call:(list-events|search-events)$/.test(call.op)) for (const ev of value?.events ?? []) if (typeof ev?.recurringEventId === "string") add({ op: "tools/call:get-event", args: { ...scope(call.args), calendarId: ev.calendarId ?? call.args.calendarId ?? "primary", eventId: ev.recurringEventId } });
  }
  return [...reads.values()];
}

for await (const line of createInterface({ input: process.stdin })) {
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
    else if (request.method === "capture" && request.params.phase === "complete") value = { collections: [{ entity: "event", complete: false }] };
    else {
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "unsupported", reason: "This plugin captures reads; replay uses the entity overlay and recording, not an emulator" }));
      continue;
    }
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
  } catch (error) {
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request?.id ?? null, status: "execution-failure", reason: error instanceof Error ? error.message : String(error) }));
  }
}
