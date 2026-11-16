import { once } from "node:events";

let seq = 0, line = 0, header, sourceType, wall = "1970-01-01T00:00:00.000Z";
const entries = new Set(["model_change", "thinking_level_change", "usage", "compaction", "context_edit", "branch_summary", "custom", "custom_message", "label", "session_info"]);
const roles = new Set(["system", "user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const blocks = new Set(["text", "image", "thinking", "toolCall"]);
async function emit(kind, op, body, fields = {}, verbatim = []) {
  const event = { v: 1, capture: "transcript", stream: "session", seq: seq++, ts: { wall }, kind, op, body: { inline: body }, verbatim, ...fields };
  if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
}
const unread = reason => emit("meta", "transcript.unread", JSON.stringify({ line, type: sourceType, reason }));
await emit("meta", "transcript.coverage", JSON.stringify({
  harness_versions: ["1.5.2"],
  carries: ["session v3 entries and branch links", "structured messages including system sections and tool declarations when logged", "assistant tool-use IDs and arguments", "tool results, error flags and logged nested-call metadata", "model selection, usage, compaction and context edits", "wall timestamps"],
  lacks: ["raw model requests and HTTP/SSE/WebSocket bytes", "MCP wire envelopes and protocol versions", "complete nested tool traffic", "unlogged system prompts or tool declarations in older sessions", "host monotonic time and per-chunk timing", "CLI argv/stdin/stderr/status beyond what the tool logged", "unreported filesystem side effects", "active branch selection beyond the recorded tree"]
}));

async function record(bytes) {
  line++;
  sourceType = undefined;
  if (!bytes.length) return;
  let raw, entry;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); entry = JSON.parse(raw); }
  catch { await unread("invalid UTF-8 or JSON"); return; }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) { await unread("not a session entry"); return; }
  sourceType = entry.type;
  const timestamp = typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp));
  if (timestamp) wall = entry.timestamp;
  else await unread("missing or invalid wall timestamp; previous wall time used only for ordering");
  const source = { source_line: line, ...(entry.id ? { session_entry_id: entry.id } : {}), ...(header?.id ? { session_id: header.id } : {}) };
  const original = ["body.inline", ...(timestamp ? ["ts.wall"] : [])];
  if (entry.type === "session") {
    header = entry;
    await emit("meta", "session.header", raw, source, original);
    if (entry.version !== 3) await unread("unsupported session version; only v3 is interpreted");
    return;
  }
  await emit("meta", `session.${typeof entry.type === "string" ? entry.type : "unknown"}`, raw, source, original);
  if (header?.version !== 3) { await unread("missing supported v3 session header"); return; }
  if (entry.type !== "message") {
    if (!entries.has(entry.type)) await unread("unknown session entry type; raw entry retained");
    return;
  }
  const message = entry.message;
  if (!message || !roles.has(message.role)) { await unread("unknown message role; raw entry retained"); return; }
  if (Array.isArray(message.content)) for (const [index, block] of message.content.entries()) {
    if (!block || !blocks.has(block.type)) { await unread("unknown content block; raw entry retained"); continue; }
    if (message.role === "assistant" && block.type === "toolCall") {
      if (typeof block.id !== "string" || typeof block.name !== "string" || !block.arguments || typeof block.arguments !== "object") { await unread("invalid tool call; raw entry retained"); continue; }
      await emit("call", block.name, JSON.stringify(block), { ...source, id: `${entry.id}:tool:${index}`, connector: "pi-tools", tool_use_id: block.id, layer: "agent" }, ["body.inline.id", "body.inline.name", "body.inline.arguments", "tool_use_id", ...(timestamp ? ["ts.wall"] : [])]);
    }
  }
  if (message.role === "toolResult") {
    if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") { await unread("invalid tool result; raw entry retained"); return; }
    await emit("result", message.toolName, JSON.stringify(message), { ...source, id: `${entry.id}:result`, connector: "pi-tools", tool_use_id: message.toolCallId, layer: "agent" }, [...Object.keys(message).map(key => `body.inline.${key}`), "tool_use_id", ...(timestamp ? ["ts.wall"] : [])]);
  }
}

let pending = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  let end;
  while ((end = pending.indexOf(10)) >= 0) {
    await record(pending.subarray(0, end));
    pending = pending.subarray(end + 1);
  }
}
if (pending.length) await record(pending);
if (!header) await unread("no session header");
await emit("close", "session.eof", "", {}, []);
