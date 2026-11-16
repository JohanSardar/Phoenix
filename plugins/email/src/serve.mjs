// The email working copy: answers the Gmail connector's tools and himalaya commands from one
// mailbox, seeded from the moment's snapshot. Speaks Phoenix plugin protocol v1 on stdio.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Mailbox } from "./mailbox.mjs";
import { Connector, TOOLS, ToolError, Unsupported } from "./connector.mjs";
import { Himalaya, folderAliases } from "./himalaya.mjs";
import { labelOf, learnHimalaya, listShape, reads, takeUids, touches } from "./learn.mjs";
import { addresses } from "./mime.mjs";

let box, connector, himalaya, aliases;
const READ_ONLY = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8")).read_only.filter(entry => entry.startsWith("himalaya "));

const DERIVED = [null, "STARRED", "IMPORTANT"];
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
        if (Array.isArray(argv)) { const run = { argv, stdin: "", stdout: "", at: event.ts?.wall }; runs.set(event.stream, run); output.push(run); }
      } else if (/^(frame|fragment):out:0$/.test(event.op ?? "") && runs.has(event.stream)) runs.get(event.stream).stdin += event.body.inline;
      else if (event.kind === "result" && event.op === "frame:back:3" && runs.has(event.stream)) runs.get(event.stream).code = JSON.parse(event.body.inline).code;
      else if (event.kind === "result" && frame && runs.has(event.stream)) runs.get(event.stream).stdout += event.body.inline;
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
    if (m.uids) { message.uids = { ...m.uids }; message.realUids = new Set(Object.keys(m.uids)); }
    box.fromRaw(message);
    if (m.threadCount !== undefined) box.threadCounts.set(message.threadId, m.threadCount);
  }
  for (const d of snapshot.drafts ?? []) box.drafts.set(d.id, d.messageId);
  const cut = snapshot.cut_at ? Date.parse(snapshot.cut_at) : Infinity;
  aliases = folderAliases(snapshot.himalaya);
  himalaya = new Himalaya(box, snapshot.himalaya);
  await himalaya.start();
  // Connector answers and himalaya calls are one history, in time order; what any himalaya call printed
  // is learned. A step without a time keeps its place after the step before it in its own list.
  // A past himalaya write that exited 0 before the cut runs again in the copy only when nothing the
  // session saw later shows a folder it changed. When a later list proves it shows every folder the
  // write changed, those lists answer alone and the write doesn't run. Otherwise the copy can't tell
  // what those folders hold, so they answer unsupported.
  const timed = (list, time, key) => { let last = -Infinity; return list.map(item => { const at = Date.parse(time(item)); last = Number.isFinite(at) ? at : last; return { order: last, at, [key]: item }; }); };
  const history = [
    ...timed(snapshot.answers ?? [], a => a.observed_at, "answer"),
    ...timed((snapshot.himalaya_output ?? []).filter(o => Array.isArray(o.argv)), o => o.at, "o"),
  ].sort((a, b) => a.order - b.order);
  const pageSize = Number(/^\s*envelope\.list\.page-size\s*=\s*(\d+)/m.exec([...((snapshot.himalaya?.accounts ?? []).find(a => a.default)?.lines ?? []), ...(snapshot.himalaya?.top ?? [])].join("\n"))?.[1]) || undefined;
  const longest = new Map();
  for (const { o } of history) {
    const shape = o && (o.code ?? 0) === 0 ? listShape(o.argv, o.stdout, aliases) : undefined;
    if (shape && shape.size === undefined) longest.set(shape.account, Math.max(longest.get(shape.account) ?? 0, shape.count));
  }
  const whole = shape => shape.first && shape.count < (shape.size ?? pageSize ?? ((longest.get(shape.account) ?? 0) > shape.count ? Infinity : 0));
  const labels = value => {
    const found = [];
    const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (Array.isArray(v.labelIds)) found.push(v.labelIds); Object.values(v).forEach(walk); } };
    walk(value);
    return found;
  };
  // What a step of the history shows of each folder, by label (null for All Mail): the whole folder or part of it.
  const shows = ({ answer, o }) => {
    const seen = new Map();
    if (answer) {
      for (const ids of labels(valueOf(answer.result))) for (const label of ids) if (!DERIVED.includes(label) && label !== "UNREAD" && !label.startsWith("CATEGORY_")) seen.set(label, "part");
      return seen;
    }
    if ((o.code ?? 0) !== 0) return seen;
    const shape = listShape(o.argv, o.stdout, aliases);
    if (shape) seen.set(labelOf(box, shape.folder), whole(shape) ? "whole" : "part");
    else if (o.argv.includes("read") && o.argv.includes("json") && /^\d+$/.test(String(o.argv.at(-1)))) seen.set(labelOf(box, aliases[String(o.argv[o.argv.indexOf("-f") + 1] ?? "").toLowerCase()] ?? (o.argv.includes("-f") ? o.argv[o.argv.indexOf("-f") + 1] : "INBOX")), "part");
    return seen;
  };
  const unsettled = new Set();
  for (const [step, { at, answer, o }] of history.entries()) {
    if (answer) {
      const tool = answer.op.replace(/^tools\/call:/, "");
      if (TOOLS.includes(tool) && !answer.result?.isError) connector.ingest(tool, answer.args, valueOf(answer.result), at, answer.before_cut !== false && at <= cut);
      continue;
    }
    learnHimalaya(box, [o], aliases);
    if (reads(o.argv, READ_ONLY) || o.code !== 0 || !(at <= cut)) continue;
    const from = /^from:\s*(.*)$/im.exec(String(o.stdin ?? "").split(/\r?\n\r?\n/)[0] ?? "")?.[1];
    if (!box.account.email && o.argv.includes("send") && from) box.account.email = addresses(from)[0]?.email ?? "";
    const later = new Map();
    for (const next of history.slice(step + 1)) {
      if (!(next.at <= cut) && Number.isFinite(next.at)) continue;
      for (const [label, how] of shows(next)) if (later.get(label) !== "whole") later.set(label, how);
    }
    const changed = touches(box, o.argv, o.stdin, aliases)?.map(folder => labelOf(box, folder));
    const known = changed && !changed.includes(undefined);
    if (!(known ? [...changed, ...DERIVED] : [...later.keys()]).some(label => later.has(label))) {
      const before = new Set(box.messages.keys());
      await himalaya.run(o.argv.slice(1), Buffer.from(o.stdin ?? ""), Number.isFinite(at) ? at : box.nowMs ?? 0);
      for (const [id, m] of box.messages) if (!before.has(id)) { m.provisional = true; box.fromRaw(m); }
      continue;
    }
    if (!known) { unsettled.add("*"); continue; }
    for (const label of changed) if (later.get(label) !== "whole") unsettled.add(label);
    for (const label of DERIVED) if (later.get(label) === "part") unsettled.add(label);
  }
  box.unsettled = unsettled;
  box.missed = undefined;
  for (const m of box.messages.values()) box.fromRaw(m);
  box.changes = [];
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
