// The email working copy: answers the Gmail connector's tools and himalaya commands from one
// mailbox, seeded from the moment's snapshot. Speaks Phoenix plugin protocol v1 on stdio.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Mailbox } from "./mailbox.mjs";
import { Connector, TOOLS, ToolError, Unsupported } from "./connector.mjs";
import { Himalaya, folderAliases } from "./himalaya.mjs";
import { learnHimalaya, takeUids } from "./learn.mjs";

let box, connector, himalaya, aliases;

const stdoutOf = frames => Buffer.concat(frames.filter(f => f.dir === "back" && f.stream === 1).map(f => Buffer.from(f.bytes, "base64"))).toString("utf8");

// When the engine runs a recorded call against the copy, it also sends the recorded answer.
const recordedBody = recorded => { try { return recorded?.body === undefined ? undefined : JSON.parse(Buffer.from(recorded.body, "base64").toString("utf8")); } catch { return undefined; } };

const valueOf = result => {
  if (!result || typeof result !== "object") return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.length === 1 && result.content[0].type === "text" ? result.content[0].text : undefined;
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
};

// A snapshot is either the plugin's own JSON or capture events (one JSON object per line). Capture
// events pair each recorded tools/call with its result, and collect what each himalaya call printed:
// a recorded call's stdout frames, or a command-line capture read's response frames.
function readSnapshot(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value) && value.kind === undefined) return value;
  } catch { /* capture events */ }
  const calls = new Map(), answers = [], runs = new Map(), output = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.body?.inline === undefined) continue;
    if (event.surface === "cli") {
      const frame = /^(frame|fragment):back:1$/.test(event.op ?? "");
      if (event.kind === "prefetch") {
        const read = JSON.parse(event.body.inline);
        if (Array.isArray(read.args?.argv)) output.push({ argv: read.args.argv, stdout: stdoutOf(JSON.parse(read.response.body)), at: event.ts?.wall });
      } else if ((event.kind === "call" || (event.kind === "meta" && event.op === "open")) && !/^(frame|fragment):/.test(event.op ?? "")) {
        const value = JSON.parse(event.body.inline);
        const argv = event.op === "open" ? value.meta?.argv : value.argv;
        if (Array.isArray(argv)) { const run = { argv, stdout: "", at: event.ts?.wall }; runs.set(event.stream, run); output.push(run); }
      } else if (event.kind === "result" && frame && runs.has(event.stream)) runs.get(event.stream).stdout += event.body.inline;
      continue;
    }
    const body = JSON.parse(event.body.inline);
    if (!body) continue;
    const key = JSON.stringify([event.stream, body.id]);
    if (event.kind === "call" && body.method === "tools/call") calls.set(key, body.params);
    if (event.kind === "result" && calls.has(key) && body.result) answers.push({ op: `tools/call:${calls.get(key).name}`, args: calls.get(key).arguments ?? {}, result: body.result, observed_at: event.ts?.wall });
  }
  return { answers, himalaya_output: output };
}

async function initialize(params) {
  const snapshot = params.snapshot ? readSnapshot(await readFile(params.snapshot, "utf8")) : {};
  const seed = params.seed ? await readFile(params.seed, "utf8").catch(() => params.seed) : "";
  box = new Mailbox(seed);
  box.timezone = snapshot.timezone ?? process.env.TZ ?? "UTC";
  if (snapshot.account) Object.assign(box.account, snapshot.account);
  if (snapshot.labels) box.labels = snapshot.labels;
  connector = new Connector(box);
  for (const m of snapshot.messages ?? []) {
    const message = box.upsert(m, { at: 0, know: m.raw ? [] : ["body"] });
    if (m.uids) message.uids = { ...m.uids };
    box.fromRaw(message);
    if (m.threadCount !== undefined) box.threadCounts.set(message.threadId, m.threadCount);
  }
  for (const d of snapshot.drafts ?? []) box.drafts.set(d.id, d.messageId);
  const cut = snapshot.cut_at ? Date.parse(snapshot.cut_at) : Infinity;
  const answers = [...(snapshot.answers ?? [])].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  for (const answer of answers) {
    const tool = answer.op.replace(/^tools\/call:/, "");
    if (!TOOLS.includes(tool) || answer.result?.isError) continue;
    const at = Date.parse(answer.observed_at);
    connector.ingest(tool, answer.args, valueOf(answer.result), at, answer.before_cut !== false && at <= cut);
  }
  aliases = folderAliases(snapshot.himalaya);
  learnHimalaya(box, (snapshot.himalaya_output ?? []).filter(o => Array.isArray(o.argv)).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)), aliases);
  for (const m of box.messages.values()) box.fromRaw(m);
  box.changes = [];
  himalaya = new Himalaya(box, snapshot.himalaya);
  await himalaya.start();
}

const rpc = (request, body) => ({ body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body })).toString("base64") });

async function call(params) {
  const nowMs = Date.parse(params.now ?? new Date().toISOString());
  if (params.surface === "cli") {
    box.missed = undefined;
    const { stdout, stderr, code } = await himalaya.run((params.args?.argv ?? []).slice(1), Buffer.from(params.raw?.stdin ?? "", "base64"), nowMs);
    if (box.missed) return { status: "unsupported", reason: box.missed };
    const recorded = recordedBody(params.recorded);
    if (Array.isArray(recorded)) takeUids(box, (params.args?.argv ?? []), stdout.toString("utf8"), stdoutOf(recorded), aliases);
    const frame = (stream, bytes, last = true) => ({ dir: "back", stream, bytes: Buffer.from(bytes).toString("base64"), last });
    const frames = [frame(1, stdout), frame(2, stderr), frame(3, JSON.stringify({ type: "exit", code, signal: null }))];
    return { status: "answer", value: { body: Buffer.from(JSON.stringify(frames)).toString("base64") } };
  }
  const request = JSON.parse(Buffer.from(params.raw.body, "base64").toString("utf8"));
  const tool = params.op.replace(/^tools\/call:/, "");
  try {
    const made = connector.call(tool, params.args, nowMs);
    const recorded = recordedBody(params.recorded)?.result;
    const value = recorded && !recorded.isError ? connector.takeIds(tool, made, valueOf(recorded)) : made;
    return { status: "answer", value: rpc(request, { result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } }) };
  } catch (error) {
    if (error instanceof Unsupported) return { status: "unsupported", reason: error.message };
    if (error instanceof ToolError) return { status: "answer", value: rpc(request, { result: { content: [{ type: "text", text: error.message }], isError: true } }) };
    throw error;
  }
}

const reply = (id, body) => process.stdout.write(JSON.stringify({ phoenix_plugin: 1, id, ...body }) + "\n");
let tail = Promise.resolve();
for await (const line of createInterface({ input: process.stdin })) {
  tail = tail.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id)) throw new Error("Invalid plugin request");
      if (request.method === "initialize") { await initialize(request.params ?? {}); reply(request.id, { status: "answer", value: null }); return; }
      if (!box) throw new Error("Initialize first");
      if (request.method === "call") { reply(request.id, await call(request.params)); return; }
      if (request.method === "state") { reply(request.id, { status: "answer", value: box.state() }); return; }
      reply(request.id, { status: "unsupported", reason: `Unknown method ${request.method}` });
    } catch (error) {
      reply(request?.id ?? null, { status: "execution-failure", reason: error instanceof Error ? error.message : String(error) });
    }
  });
}
await tail;
await himalaya?.stop();
