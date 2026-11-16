import { readFileSync } from "node:fs";
import { readNative } from "./native-reader.mjs";

let seq = 0, wall = "1970-01-01T00:00:00.000Z", task;
function emit(kind, op, value, verbatim = [], fields = {}) {
  process.stdout.write(JSON.stringify({ v: 1, capture: "reader", stream: "fx-session", seq: seq++, ts: { wall }, kind, op, ...(task ? { task } : {}), body: { inline: JSON.stringify(value) }, verbatim, ...fields }) + "\n");
}
function unread(type, reason, at) {
  emit("meta", "transcript.unread", { type, reason, at });
}
emit("meta", "transcript.coverage", {
  harness_versions: ["0.0.16"],
  carries: ["saved user and assistant text", "tool-call ids, names and argument JSON", "native log result previews and artifact references, or exported tool-result text and truncation metadata", "execution context and compaction records when present", "native record wall times, or session creation/update wall times for exports"],
  lacks: ["raw model requests and responses", "complete system prompt and tool definitions", "MCP initialize, protocol version and raw envelopes", "individual call times in exports; all monotonic times", "CLI stdin/stdout/stderr frames and environment", "result-store artifacts outside the supplied bytes", "unsaved sessions and omitted subagent sessions"],
});
try {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0));
  let input;
  try { input = JSON.parse(text); } catch {}
  if (!input || input.v === 1 && input.kind === "session_created") {
    readNative(text, emit, unread);
    process.exitCode ??= 0;
  } else {
  if (input.fx_version !== "0.0.16") throw new Error("Unsupported fx version");
  const session = input.session;
  if (session?.kind !== "session_detail" || !Array.isArray(session.history) || !Number.isFinite(session.created_at_ms)) throw new Error("Unsupported session export");
  wall = new Date(session.created_at_ms).toISOString();
  task = session.id;
  emit("meta", "fx.session", Object.fromEntries(Object.entries(session).filter(([key]) => key !== "history")), ["body", "task", "ts.wall"]);
  for (const [index, turn] of session.history.entries()) {
    const at = `history[${index}]`;
    if (!["assistant", "interrupted", "compacted_summary"].includes(turn.kind)) { unread(turn.kind, "Unknown history kind", at); continue; }
    if (turn.kind === "compacted_summary") { emit("meta", "fx.compacted_summary", turn, ["body"]); continue; }
    if (turn.user) emit("meta", "fx.user", turn.user, ["body"]);
    const execution = turn.execution;
    if (execution) {
      if (execution.schema_version !== 3 || !Array.isArray(execution.tool_steps)) {
        unread("execution", "Unsupported execution schema", at);
      } else {
        emit("meta", "fx.execution", Object.fromEntries(Object.entries(execution).filter(([key]) => key !== "tool_steps")), ["body"]);
        for (const [stepIndex, step] of execution.tool_steps.entries()) {
          if (!Array.isArray(step.tool_calls) || !Array.isArray(step.tool_results)) { unread("tool_step", "Missing call/result arrays", `${at}.tool_steps[${stepIndex}]`); continue; }
          if (step.assistant != null) emit("meta", "fx.assistant", step.assistant, ["body"]);
          for (const call of step.tool_calls) {
            if (typeof call.id !== "string" || typeof call.name !== "string" || typeof call.arguments_json !== "string") { unread("tool_call", "Missing call fields", at); continue; }
            emit("call", call.name, call, ["body", "tool_use_id"], { tool_use_id: call.id, layer: "agent" });
          }
          for (const result of step.tool_results) {
            if (typeof result.tool_call_id !== "string" || typeof result.output !== "string") { unread("tool_result", "Missing result fields", at); continue; }
            emit("result", result.tool_name, result, ["body", "tool_use_id"], { tool_use_id: result.tool_call_id, layer: "agent", ...(result.truncated || result.completeness === "partial" ? { partial: true } : {}) });
          }
          const rest = Object.fromEntries(Object.entries(step).filter(([key]) => !["assistant", "tool_calls", "tool_results"].includes(key)));
          if (Object.keys(rest).length) emit("meta", "fx.step", rest, ["body"]);
        }
      }
    }
    if (turn.assistant != null) emit("meta", "fx.assistant", turn.assistant, ["body"]);
    const extra = Object.fromEntries(Object.entries(turn).filter(([key]) => !["kind", "user", "assistant", "execution"].includes(key)));
    if (Object.keys(extra).length) emit("meta", `fx.${turn.kind}`, extra, ["body"]);
    if (turn.kind === "interrupted") unread("interrupted", "Session turn did not complete", at);
  }
  if (Number.isFinite(session.updated_at_ms)) wall = new Date(session.updated_at_ms).toISOString();
  emit("close", "fx.session.end", { updated_at_ms: session.updated_at_ms }, ["body", "ts.wall"]);
  }
} catch {
  unread("source", "Malformed or unsupported version-stamped session export");
  process.exitCode = 1;
}
