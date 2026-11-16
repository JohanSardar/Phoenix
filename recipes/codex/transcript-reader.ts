import { createInterface } from "node:readline";

type RecordValue = Record<string, any>;
let seq = 0, session: string | undefined, version: string | undefined;
const calls = new Map<string, { connector: string; op: string }>();
function emit(kind: string, row: RecordValue, fields: RecordValue = {}, body: unknown = row.payload, verbatim: string[] = []) {
  process.stdout.write(JSON.stringify({ v: 1, capture: "reader", stream: "session", seq: seq++, ts: { wall: row.timestamp }, kind, route: "transcript", ...(session && !process.argv.includes("--single-run") ? { task: session } : {}), ...fields, ...(body === undefined ? {} : { body: { inline: typeof body === "string" ? body : JSON.stringify(body) } }), verbatim }) + "\n");
}
function unread(row: RecordValue, line: number, reason: string) {
  emit("meta", row, { op: "transcript.unread" }, { line, type: typeof row.type === "string" ? row.type : "unknown", reason });
}
let line = 0;
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  line++;
  let row: RecordValue;
  try { row = JSON.parse(text); } catch { row = {}; }
  if (!row || typeof row !== "object" || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) {
    unread({ timestamp: "1970-01-01T00:00:00.000Z" }, line, "invalid record or missing wall time"); continue;
  }
  const p: RecordValue = row.payload;
  if (!p || typeof p !== "object") { unread(row, line, "missing payload"); continue; }
  if (row.type === "session_meta") {
    version = p.cli_version;
    session = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : undefined;
    emit("meta", row, { op: "transcript.coverage" }, {
      harness_versions: ["0.169.0"],
      carries: ["logged model-visible response items", "logged tool names, inputs, outputs and call IDs", "completed MCP and command items including logged argv and exit code", "session and turn context", "wall timestamps", "logged base instructions"],
      lacks: ["model HTTP requests and responses", "provider-held history", "complete tool catalog and MCP protocol version", "MCP wire envelopes", "raw CLI streams, terminal/exit controls and filesystem effects", "monotonic time and stream chunk timings", "unlogged or encrypted reasoning"],
    });
    if (version !== "0.169.0") { unread(row, line, "unsupported cli_version"); continue; }
    emit("meta", row, { op: "session_meta" }, { id: session, cli_version: version, cwd: p.cwd, model_provider: p.model_provider, base_instructions: p.base_instructions }, ["ts.wall", "body.cli_version", "body.cwd", "body.model_provider", "body.base_instructions", ...(!process.argv.includes("--single-run") && session ? ["task"] : [])]);
    continue;
  }
  if (version !== "0.169.0") { unread(row, line, "no supported session header"); continue; }
  if (row.type === "response_item") {
    if (["function_call", "custom_tool_call"].includes(p.type) && typeof p.name === "string" && typeof p.call_id === "string") {
      const fields = { connector: "codex-tools", op: p.name };
      calls.set(p.call_id, fields);
      emit("call", row, { ...fields, source_id: p.call_id, layer: "agent" }, p, ["ts.wall", "source_id", "body"]);
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type) && typeof p.call_id === "string") {
      const call = calls.get(p.call_id);
      if (!call) { unread(row, line, "tool output has no preceding call"); continue; }
      emit("result", row, { ...call, source_id: p.call_id, layer: "agent" }, p, ["ts.wall", "source_id", "body"]);
    } else if (["message", "reasoning", "additional_tools", "web_search_call", "local_shell_call", "image_generation_call", "compaction", "compaction_trigger"].includes(p.type)) {
      emit("meta", row, { op: `response_item.${p.type}` }, p, ["ts.wall", "body"]);
    } else unread(row, line, "unknown response item");
  } else if (["turn_context", "world_state", "token_usage_record", "compacted"].includes(row.type)) {
    emit("meta", row, { op: row.type }, p, ["ts.wall", "body"]);
  } else if (row.type === "event_msg" && p.type === "item_completed" && ["McpToolCall", "CommandExecution"].includes(p.item?.type)) {
    const item = p.item;
    if (typeof item.id !== "string" || item.type === "McpToolCall" && (typeof item.server !== "string" || typeof item.tool !== "string")) { unread(row, line, "invalid completed tool item"); continue; }
    const fields = item.type === "McpToolCall" ? { surface: "mcp", connector: item.server, op: `tools/call:${item.tool}` } : { surface: "cli", connector: "codex-shell", op: "exec" };
    const start = typeof p.started_at_ms === "number" && Number.isFinite(p.started_at_ms) ? new Date(p.started_at_ms).toISOString() : row.timestamp;
    emit("call", { ...row, timestamp: start }, { ...fields, source_id: item.id, layer: "agent" }, item, ["source_id", "body"]);
    emit("result", row, { ...fields, source_id: item.id, layer: "agent" }, item, ["ts.wall", "source_id", "body"]);
  } else if (row.type === "event_msg" && ["task_started", "task_complete", "thread_settings_applied", "item_completed", "token_count", "agent_message", "user_message", "agent_reasoning", "exec_command_begin", "exec_command_end", "mcp_tool_call_begin", "mcp_tool_call_end", "turn_aborted", "context_compacted", "warning", "error"].includes(p.type)) {
    emit("meta", row, { op: `event_msg.${p.type}` }, p, ["ts.wall", "body"]);
  } else unread(row, line, "unknown record type");
}
