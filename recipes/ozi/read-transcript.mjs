import { basename } from "node:path";

const versions = ["0.1.0", "0.1.4"];
const protocols = new Set(["claude-agent-sdk.query", "codex.app-server", "acp.ndjson-jsonrpc", "pi.rpc-jsonl", "muse.msp-jsonl", "cursor-agent-sdk.local", "opencode-sdk.sse", "opencode2-http.sse"]);
const source = basename(process.env.PHOENIX_SOURCE ?? "");
const fileThread = /^events\.(.+)\.log(?:\.\d+)?$/.exec(source)?.[1];
const thread = fileThread === "_global" ? undefined : fileThread;
const decoder = new TextDecoder("utf-8", { fatal: true });
let sequence = 0;
let wall = "1970-01-01T00:00:00.000Z";
let line = 0;
let pending = Buffer.alloc(0);

function emit(kind, op, body, extra = {}, verbatim = []) {
  process.stdout.write(JSON.stringify({ v: 1, capture: "reader", stream: "ozi-log", seq: sequence++, ts: { wall }, kind, op, body: { inline: body }, verbatim, ...extra }) + "\n");
}

function unread(reason, type) {
  emit("meta", "transcript.unread", JSON.stringify({ line, ...(type ? { type } : {}), reason }));
}

emit("meta", "transcript.coverage", JSON.stringify({
  harness_versions: versions,
  carries: ["Ozi provider log JSON as written", "observed wall times", "thread identity from per-thread log names", "native provider messages and any tool arguments/results the log retained", "canonical and orchestration records when present"],
  lacks: ["model HTTP request/response wire bytes", "MCP JSON-RPC wire exchanges and complete tool schemas", "CLI stdin/stdout/stderr bytes and exit status", "filtered token/progress deltas", "records removed by rotation, retention or bounded logging", "complete system prompt and provider-held history", "monotonic timing", "working-directory snapshots"],
}));

function record(bytes) {
  line++;
  let text;
  try { text = decoder.decode(bytes); } catch { unread("invalid UTF-8"); return; }
  if (!text.trim()) return;
  const match = /^\[([^\]]+)\] (NTIVE|CANON|ORCH): (.*)$/.exec(text.replace(/\r$/, ""));
  if (!match) { unread("unknown log framing"); return; }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(match[1]) || !Number.isFinite(Date.parse(match[1]))) {
    unread("invalid observed wall time"); return;
  }
  wall = match[1];
  let value;
  try { value = JSON.parse(match[3]); } catch { unread("invalid JSON", match[2]); return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) { unread("unknown event envelope", match[2]); return; }
  const native = value.kind === "protocol" ? value : value.event;
  const sourceTask = typeof value.threadId === "string" ? value.threadId : typeof native?.threadId === "string" ? native.threadId : undefined;
  const task = sourceTask ?? thread;
  const identity = task ? { task } : {};
  emit("meta", `ozi.${match[2].toLowerCase()}`, match[3], identity, ["ts.wall", "body.inline", ...(sourceTask === task && task ? ["task"] : [])]);
  if (value.truncated === true || value.event?.truncated === true || value.event?.payload?.truncated === true || native?.payload?.truncated === true || native?.payload?.payload?.truncated === true) unread("Ozi retained only a bounded summary", match[2]);
  if (Object.hasOwn(value, "version") || Object.hasOwn(value, "v")) unread("unexpected versioned event envelope", match[2]);
  if (match[2] === "NTIVE") {
    if (native?.kind !== "protocol" || !protocols.has(native.protocol) || (!native.event && !native.payload)) {
      unread("unknown native protocol or version", match[2]); return;
    }
    const payload = native.event?.payload ?? native.payload?.payload;
    if (native.protocol === "claude-agent-sdk.query" && payload?.type === "query.open" && task) {
      emit("task", "start", JSON.stringify({ provider_session: native.providerSessionId }), identity);
    }
    if (native.protocol === "claude-agent-sdk.query" && payload?.type === "result" && task) {
      emit("task", "end", JSON.stringify({ provider_session: native.providerSessionId }), identity);
    }
  } else if (typeof value.type !== "string") unread("unknown structured event type", match[2]);
}

for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  let end;
  while ((end = pending.indexOf(10)) !== -1) {
    record(pending.subarray(0, end));
    pending = pending.subarray(end + 1);
  }
}
if (pending.length) record(pending);
