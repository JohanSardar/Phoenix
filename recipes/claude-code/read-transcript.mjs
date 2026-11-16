let seq = 0;
const emit = (kind, op, value, row = {}, extra = {}, verbatim = []) => {
  const fromLog = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp));
  const wall = fromLog ? row.timestamp : new Date().toISOString();
  process.stdout.write(JSON.stringify({ v: 1, capture: "reader", stream: "session", seq: seq++, ts: { wall }, kind, op,
    ...(typeof row.sessionId === "string" ? { session_id: row.sessionId } : {}), ...extra,
    body: { inline: JSON.stringify(value) }, verbatim: [...verbatim, ...(fromLog ? ["ts.wall"] : []), ...(typeof row.sessionId === "string" ? ["session_id"] : [])] }) + "\n");
};
emit("meta", "transcript.coverage", {
  harness_versions: ["2.1.325"],
  carries: ["user and assistant messages", "thinking blocks when logged", "tool names, inputs, ids and result blocks", "session id, wall timestamps and source records", "request-shape, request-delta and attachment records when logged"],
  lacks: ["HTTP requests/responses and wire bytes", "complete system prompt and provider configuration", "MCP tool lists, protocol version and result envelopes", "CLI argv, stdin, separate stderr, exit status and filesystem effects", "stream chunk timing and host monotonic clock", "unlogged or compacted history"],
});
const known = new Set(["user", "assistant", "system", "progress", "file-history-snapshot", "queue-operation", "last-prompt", "summary", "custom-title", "agent-name", "agent-color", "tag", "pr-link", "saved_hook_context", "attribution-snapshot", "session-owner", "atis-latch", "api-request-blob", "api-request-shape", "api-request", "tools-used", "cost-state", "attachment"]);
const calls = new Map();
let sawVersion = false;
async function* lines() {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let start = 0;
    for (let i = 0; i < pending.length; i++) if (pending[i] === 10) {
      yield pending.subarray(start, i);
      start = i + 1;
    }
    pending = pending.subarray(start);
  }
  if (pending.length) yield pending;
}
let line = 0;
for await (const bytes of lines()) {
  line++;
  let row;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim()) continue;
    row = JSON.parse(text);
  } catch {
    emit("meta", "transcript.unread", { line, reason: "Invalid UTF-8 or JSON" });
    continue;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    emit("meta", "transcript.unread", { line, reason: "Expected a session record" });
    continue;
  }
  emit("meta", "transcript.record", row, row, { source_line: line }, ["body.inline"]);
  if (!known.has(row.type) || (row.version !== undefined && row.version !== "2.1.325")) {
    emit("meta", "transcript.unread", { line, type: row.type, reason: "Unsupported record type or harness version" }, row);
    continue;
  }
  if (row.version === "2.1.325") sawVersion = true;
  if (!["user", "assistant"].includes(row.type)) continue;
  const message = row.message;
  if (!message || !["user", "assistant"].includes(message.role) || !(typeof message.content === "string" || Array.isArray(message.content))) {
    emit("meta", "transcript.unread", { line, reason: "Unsupported message shape" }, row);
    continue;
  }
  emit("meta", "transcript.message", message, row, { source_line: line }, ["body.inline"]);
  if (!Array.isArray(message.content)) continue;
  for (const block of message.content) {
    if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name);
      const extra = { id: block.id, connector: mcp ? mcp[1] : `builtin:${block.name}`, ...(mcp ? { surface: "mcp" } : {}), layer: "agent", source_line: line };
      if (calls.has(block.id)) {
        if (calls.get(block.id).body !== JSON.stringify(block)) emit("meta", "transcript.unread", { line, reason: "Conflicting duplicate tool call" }, row);
        continue;
      }
      calls.set(block.id, { ...extra, body: JSON.stringify(block), op: mcp ? `tools/call:${mcp[2]}` : block.name });
      emit("call", mcp ? `tools/call:${mcp[2]}` : block.name, block, row, extra, ["id", "body.inline"]);
    } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      const call = calls.get(block.tool_use_id);
      if (!call) {
        emit("meta", "transcript.unread", { line, reason: "Tool result has no preceding call" }, row);
        continue;
      }
      emit("result", call.op, block, row, { connector: call.connector, ...(call.surface ? { surface: call.surface } : {}), layer: "agent", call_id: block.tool_use_id, source_line: line }, ["body.inline", "call_id"]);
    } else if (!["text", "thinking", "redacted_thinking", "image", "document", "tool_reference"].includes(block?.type)) {
      emit("meta", "transcript.unread", { line, reason: "Unsupported content block" }, row);
    }
  }
}
if (!sawVersion) emit("meta", "transcript.unread", { reason: "No supported harness version was recorded" });
