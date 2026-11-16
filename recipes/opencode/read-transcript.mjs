import { once } from "node:events";

let seq = 0, line = 0, header, wall = "1970-01-01T00:00:00.000Z";
async function emit(kind, op, body, fields = {}, verbatim = []) {
  const event = { v: 1, capture: "transcript", stream: "session", seq: seq++, ts: { wall }, kind, op, body: { inline: body }, verbatim, ...fields };
  if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
}
const unread = reason => emit("meta", "transcript.unread", JSON.stringify({ line, reason }));
await emit("meta", "transcript.coverage", JSON.stringify({
  harness_versions: ["1.19.5"],
  carries: ["the session as OpenCode exports it, one message per line", "user and assistant messages with their parts", "tool calls with their call IDs, input, output, title, metadata and errors", "LLM provider, model, variant and agent per message", "wall timestamps"],
  lacks: ["system prompts and tool declarations", "raw LLM requests and HTTP bytes", "subagent sessions started by the task tool", "MCP server identities behind MCP tool names", "filesystem side effects"],
}));

async function record(bytes) {
  line++;
  if (!bytes.length) return;
  let raw, entry;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); entry = JSON.parse(raw); }
  catch { await unread("invalid UTF-8 or JSON"); return; }
  if (line === 1) {
    header = entry;
    if (entry?.opencode_session !== 1 || !entry.info?.id) await unread("not an OpenCode session export made by export.mjs");
    if (Number.isFinite(entry?.info?.time?.created)) wall = new Date(entry.info.time.created).toISOString();
    await emit("meta", "session.header", raw, { source_line: line, ...(entry?.info?.id ? { session_id: entry.info.id } : {}) }, ["body.inline"]);
    return;
  }
  const info = entry?.info;
  if (!info || !["user", "assistant"].includes(info.role) || !Array.isArray(entry.parts)) { await unread("not an OpenCode message"); return; }
  if (Number.isFinite(info.time?.created)) wall = new Date(info.time.created).toISOString();
  const source = { source_line: line, session_entry_id: info.id, ...(header?.info?.id ? { session_id: header.info.id } : {}) };
  await emit("meta", "session.message", raw, source, ["body.inline", "ts.wall"]);
  for (const part of entry.parts) {
    if (part.type !== "tool") continue;
    if (typeof part.callID !== "string" || typeof part.tool !== "string" || !part.state) { await unread("invalid tool part"); continue; }
    await emit("call", part.tool, JSON.stringify({ id: part.callID, name: part.tool, input: part.state.input ?? {} }), { ...source, id: part.id + ":call", connector: "opencode", tool_use_id: part.callID, layer: "agent" }, ["body.inline.id", "body.inline.name", "body.inline.input", "tool_use_id"]);
    if (part.state.status === "completed" || part.state.status === "error") await emit("result", part.tool, JSON.stringify(part.state), { ...source, id: part.id + ":result", connector: "opencode", tool_use_id: part.callID, layer: "agent" }, ["body.inline", "tool_use_id"]);
  }
}

let pending = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  let end;
  while ((end = pending.indexOf(10)) >= 0) { await record(pending.subarray(0, end)); pending = pending.subarray(end + 1); }
}
if (pending.length) await record(pending);
if (!header) await unread("empty session");
await emit("close", "session.eof", "", {}, []);
