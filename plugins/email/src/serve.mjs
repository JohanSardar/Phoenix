// The email working copy: answers the Gmail connector's tools and himalaya commands from one
// mailbox, seeded from the moment's snapshot. Speaks Phoenix plugin protocol v1 on stdio.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Mailbox } from "./mailbox.mjs";
import { Connector, TOOLS, ToolError, Unsupported } from "./connector.mjs";
import { Himalaya } from "./himalaya.mjs";

let box, connector, himalaya;

const valueOf = result => {
  if (!result || typeof result !== "object") return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.length === 1 && result.content[0].type === "text" ? result.content[0].text : undefined;
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
};

async function initialize(params) {
  const snapshot = params.snapshot ? JSON.parse(await readFile(params.snapshot, "utf8")) : {};
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
    const { stdout, stderr, code } = await himalaya.run((params.args?.argv ?? []).slice(1), "", nowMs);
    if (box.missed) return { status: "unsupported", reason: box.missed };
    const frame = (stream, bytes, last = true) => ({ dir: "back", stream, bytes: Buffer.from(bytes).toString("base64"), last });
    const frames = [frame(1, stdout), frame(2, stderr), frame(3, JSON.stringify({ type: "exit", code, signal: null }))];
    return { status: "answer", value: { body: Buffer.from(JSON.stringify(frames)).toString("base64") } };
  }
  const request = JSON.parse(Buffer.from(params.raw.body, "base64").toString("utf8"));
  const tool = params.op.replace(/^tools\/call:/, "");
  try {
    const value = connector.call(tool, params.args, nowMs);
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
