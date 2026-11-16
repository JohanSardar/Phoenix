// Plans the moment's read-only snapshot from the session's own Sentry calls (spec/plugin.md, capture orchestration).
// It repeats every read the session made, and reads each issue the session touched or saw, plus the signed-in user.
// The host makes these reads; this sidecar makes no network calls.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
const MAX_ISSUES = 25;
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
  const reads = new Map();
  const issues = new Map();
  const add = (op, args) => reads.set(JSON.stringify([op, args]), { op, args });
  const issue = (org, id) => { if (typeof org === "string" && typeof id === "string" && issues.size < MAX_ISSUES) issues.set(`${org}/${id}`, { organizationSlug: org, issueId: id }); };
  add("tools/call:whoami", {});
  add("tools/call:find_organizations", {});
  const pending = new Map();
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
      const args = message.params?.arguments ?? {};
      if (!descriptor.operations.includes(op) || !args || typeof args !== "object" || Array.isArray(args)) continue;
      pending.set(key, { op, args });
      issue(args.organizationSlug, args.issueId);
      continue;
    }
    const call = pending.get(key);
    pending.delete(key);
    if (!call || message.error || !message.result || message.result.isError) continue;
    if (descriptor.read_only.includes(call.op)) add(call.op, call.args);
    const text = (message.result.content ?? []).map(block => block?.text ?? "").join("\n");
    for (const [, org, id] of text.matchAll(/https:\/\/([a-z0-9-]+)\.sentry\.io\/issues\/([A-Z0-9][A-Z0-9-]*-[A-Z0-9]+)\b/g)) issue(org, id);
  }
  for (const args of issues.values()) {
    add("tools/call:get_issue_details", args);
    add("tools/call:get_issue_activity", args);
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
    else if (request.method === "capture" && request.params.phase === "complete") value = { collections: [{ entity: "issue", complete: false }] };
    else {
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "unsupported", reason: "The capture command plans reads; the serve command is the working copy" }));
      continue;
    }
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
  } catch (error) {
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request?.id ?? null, status: "execution-failure", reason: error instanceof Error ? error.message : String(error) }));
  }
}
