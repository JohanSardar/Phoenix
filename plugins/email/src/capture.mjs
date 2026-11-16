// Plans the reads that snapshot what the session touched: each thread, message and draft it saw,
// and the label list. Every planned read is a declared read-only tool. Makes no network calls.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
const MESSAGE_RESULTS = new Set(["get_message", "send_message", "reply", "forward"]);
const DRAFT_RESULTS = new Set(["create_draft", "update_draft", "get_draft"]);
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
  const threads = new Set(), messages = new Set(), drafts = new Set();
  const add = (set, id) => { if (typeof id === "string" && id) set.add(id); };
  const pending = new Map();
  let used = false;
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
      if (message.method !== "tools/call" || !descriptor.operations.includes("tools/call:" + message.params?.name)) continue;
      const args = message.params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      used = true;
      pending.set(key, message.params.name);
      add(threads, args.threadId); add(messages, args.messageId); add(messages, args.replyToMessageId); add(drafts, args.draftId);
      continue;
    }
    const tool = pending.get(key);
    pending.delete(key);
    if (!tool || message.error || !message.result || message.result.isError) continue;
    let value = message.result.structuredContent;
    if (value === undefined && message.result.content?.length === 1 && message.result.content[0].type === "text") {
      try { value = JSON.parse(message.result.content[0].text); } catch { continue; }
    }
    if (!value || typeof value !== "object") continue;
    add(threads, value.threadId); add(messages, value.messageId);
    if (MESSAGE_RESULTS.has(tool)) add(messages, value.id);
    if (DRAFT_RESULTS.has(tool)) add(drafts, value.id);
    if (tool === "get_thread") add(threads, value.id);
    for (const thread of value.threads ?? []) { add(threads, thread.id); for (const m of thread.messages ?? []) add(messages, m.id); }
    for (const m of value.messages ?? []) { add(messages, m.id); add(threads, m.threadId); }
    for (const d of value.drafts ?? []) { add(drafts, d.id); add(messages, d.messageId); add(threads, d.threadId); }
  }
  if (!used) return [];
  return [
    { op: "tools/call:list_labels", args: {} },
    ...[...threads].map(threadId => ({ op: "tools/call:get_thread", args: { threadId, messageFormat: "FULL_CONTENT" } })),
    ...[...messages].map(messageId => ({ op: "tools/call:get_message", args: { messageId, messageFormat: "RAW" } })),
    ...[...drafts].map(draftId => ({ op: "tools/call:get_draft", args: { draftId, messageFormat: "FULL_CONTENT" } })),
  ];
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
    else if (request.method === "capture" && request.params.phase === "complete") value = { collections: [{ entity: "message", complete: false }, { entity: "draft", complete: false }] };
    else {
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "unsupported", reason: "The capture command does not answer " + request.method }));
      continue;
    }
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
  } catch (error) {
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request?.id ?? null, status: "execution-failure", reason: error instanceof Error ? error.message : String(error) }));
  }
}
