import { parentPort, workerData } from "node:worker_threads";
import { appendCoverage, BlobStore, createTraceWriter, readJsonLines } from "@phoenix/store";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TraceEvent, RecipeDescriptor } from "@phoenix/formats";
import type { Copy, Connection } from "./tee.ts";
import { sanitizeMessage, sanitizeObject, secretPolicy } from "./secrets.ts";

const { root, home, stream } = workerData as { root: string; home: string; stream: string };
const metadata = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as { capture: string; task_key?: RecipeDescriptor["task_keys"] };
const policy = await secretPolicy(home), blobs = new BlobStore(root);
const writer = createTraceWriter(root, { capture: metadata.capture, stream });
const gapStream = `${stream}.gaps.${randomUUID()}`;
const gaps = createTraceWriter(root, { capture: metadata.capture, stream: gapStream });
let connection: Connection, seq = -1, gapSeq = 0, closed = false;
let requestHeaders: string[] = [], responseHeaders: string[] = [];
let task: string | undefined;
type Message = { parts: Buffer[]; chunks: NonNullable<TraceEvent["chunks"]>; size: number; first: Copy; partial: boolean; omitted?: boolean };
const messages = new Map<string, Message>();
const mcpTasks = new Map<string, string>();
let buffered = 0;
const event = (copy: Copy, kind: TraceEvent["kind"]): TraceEvent => ({
  v: 1, capture: metadata.capture, stream, seq: copy.seq, ts: { wall: copy.wall, mono: copy.mono }, kind,
  route: "tap", surface: connection.surface, connector: connection.connector, layer: "agent", ...(task ? { task } : {}),
});
const headers = (raw: string[]) => Object.fromEntries(Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2]!.toLowerCase(), raw[i * 2 + 1]!]));
function taskKey(body: unknown, rawHeaders: string[] = []): string | undefined {
  for (const rule of metadata.task_key ?? []) {
    let value: unknown;
    if ("header" in rule) { const index = rawHeaders.findIndex((v, i) => i % 2 === 0 && v.toLowerCase() === rule.header.toLowerCase()); if (index >= 0) value = rawHeaders[index + 1]; }
    else {
      const path = "meta" in rule ? ["_meta", rule.meta] : rule.json_path.replace(/^\$\.?/, "").split(".");
      value = body;
      for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
async function store(copy: Copy, kind: TraceEvent["kind"], bytes: Buffer, extra: Partial<TraceEvent> = {}, rawHeaders: string[] = []) {
  const h = headers(rawHeaders);
  const result = await sanitizeMessage({ body: bytes, contentType: h["content-type"], contentEncoding: h["content-encoding"] }, policy);
  const clean = Buffer.from(result.msg.body ?? []);
  if (kind === "call" || kind === "result") {
    try {
      const value = JSON.parse(clean.toString()) as Record<string, unknown>;
      const own = taskKey(value, requestHeaders), id = value.id === undefined ? undefined : JSON.stringify(value.id);
      if (connection.surface === "mcp") {
        task = own ?? (id ? mcpTasks.get(id) : undefined);
        if (own && id && kind === "call") mcpTasks.set(id, own);
        if (id && kind === "result") mcpTasks.delete(id);
      } else task = own ?? task;
    } catch {}
  }
  const e = { ...event(copy, kind), ...extra, secrets: result.unscanned.length ? "unscanned" as const : result.changes };
  const encoding = result.originalEncoding ? { content_encoding: result.originalEncoding } : {};
  if (clean.length > 32 * 1024 || result.unscanned.length || (e.chunks?.length ?? 0) > 1) {
    e.body = { inline: "", ...encoding };
    const spool = await blobs.spool(e);
    const chunks = result.changes.length || result.originalEncoding ? [{ offset: 0, at: copy.mono }] : e.chunks ?? [{ offset: 0, at: copy.mono }];
    for (let i = 0; i < chunks.length; i++) await spool.append(clean.subarray(chunks[i]!.offset, chunks[i + 1]?.offset ?? clean.length), chunks[i]!.at);
    writer.append(await spool.finish());
    await spool.release();
  } else { e.body = { inline: clean.toString(), ...encoding }; writer.append(e); }
}
async function flush(copy: Copy, partial: boolean) {
  for (const [key, msg] of messages) {
    if (!msg.size) continue;
    const [dir, channel] = key.split(":");
    const result = await sanitizeMessage({ body: Buffer.concat(msg.parts) }, policy);
    gaps.append(Object.assign({ ...event(copy, dir === "out" ? "call" : "result"), stream: gapStream, seq: gapSeq++, partial, op: `frame:${dir}:${channel}`, body: { blob: await blobs.put(result.msg.body ?? new Uint8Array()) }, chunks: msg.chunks, secrets: result.unscanned.length ? "unscanned" as const : result.changes }, copy.aborted ? { aborted: true } : {}));
  }
  messages.clear();
  buffered = 0;
}
async function accept(copy: Copy | { type: "disconnect" }) {
  if (closed) return;
  if (copy.type === "disconnect") {
    closed = true;
    const stamp: Copy = { type: "close", stream, seq: ++seq, wall: new Date().toISOString(), mono: process.hrtime.bigint().toString() };
    gaps.append({ ...event(stamp, "gap"), stream: gapStream, seq: gapSeq++, body: { inline: "tap-disconnected-without-close" } });
    await flush(stamp, true);
    await gaps.close(); parentPort!.close(); return;
  }
  if (copy.type === "open") {
    connection = copy.connection!;
    const meta = (await sanitizeObject(connection, policy) as Connection).meta as { request?: { headers: string[] } };
    requestHeaders = meta.request?.headers ?? [];
    task = taskKey(undefined, requestHeaders);
    const files = (await readdir(join(root, "seg"))).filter(name => name.startsWith(`${stream}.`));
    let previous = -1;
    for (const file of files) for (const row of (await readJsonLines(join(root, "seg", file), value => value as TraceEvent)).values) if (row.stream === stream) previous = Math.max(previous, row.seq);
    if (files.length || copy.seq > 0) {
      gaps.append({ ...event(copy, "gap"), stream: gapStream, seq: gapSeq++, ...(copy.seq > previous + 1 ? { dropped: { from: previous + 1, to: copy.seq - 1, bytes: copy.dropped?.bytes ?? 0 } } : {}), body: { inline: "collector-reconnect" } });
    }
    seq = copy.seq;
    await store({ ...copy, seq }, "meta", Buffer.from(JSON.stringify(connection)), { op: "open" });
    await appendCoverage(root, { stream, route: "tap", surface: connection.surface, connector: connection.connector, mode: (connection.meta as { mode?: string }).mode ?? "stdio", at: copy.wall });
    return;
  }
  if (copy.dropped) {
    gaps.append({ ...event(copy, "gap"), stream: gapStream, seq: gapSeq++, dropped: copy.dropped });
  }
  if (copy.type === "close") {
    await flush(copy, true); closed = true; await writer.close(); await gaps.close(); parentPort!.close(); return;
  }
  const f = copy.frame!, bytes = Buffer.from(f.bytes, "base64"), key = `${f.dir}:${f.stream}`;
  const http = (connection.meta as { transport?: string }).transport === "http";
  if (http && f.stream === 1) {
    responseHeaders = (JSON.parse(bytes.toString()) as { headers: string[] }).headers;
  }
  let msg = messages.get(key);
  if (!msg) { msg = { parts: [], chunks: [], size: 0, first: copy, partial: !f.first || f.partial }; messages.set(key, msg); }
  msg.partial ||= f.partial;
  if (!msg.omitted) {
    if (buffered + bytes.length > 32 * 1024 * 1024) { buffered -= msg.size; msg.parts = []; msg.chunks = []; msg.omitted = true; msg.partial = true; }
    else { msg.chunks.push({ offset: msg.size, at: copy.mono }); msg.parts.push(bytes); buffered += bytes.length; }
  }
  msg.size += bytes.length;
  seq = copy.seq;
  if (!f.last) { writer.append({ ...event(copy, "meta"), op: `fragment:${key}` }); return; }
  messages.delete(key);
  if (msg.omitted) { writer.append({ ...event(copy, "gap"), partial: true, dropped: { from: msg.first.seq, to: copy.seq, bytes: msg.size }, body: { inline: "message exceeded collector assembly bound" } }); return; }
  buffered -= msg.size;
  const body = Buffer.concat(msg.parts);
  if (!body.length) { writer.append({ ...event(copy, "meta"), op: `frame:${key}` }); return; }
  await store({ ...copy, seq }, http && f.stream !== 0 && f.stream !== 2 ? "meta" : f.dir === "out" ? "call" : "result", body,
    { op: `frame:${f.dir}:${f.stream}`, id: `${stream}:${copy.seq}`, chunks: msg.chunks, ...(msg.partial ? { partial: true } : {}) }, http ? f.dir === "out" ? requestHeaders : responseHeaders : []);
}
let pending = Promise.resolve();
parentPort!.on("message", (copy: Copy | { type: "disconnect" }) => {
  pending = pending.then(() => accept(copy)).then(() => { if (!closed) parentPort!.postMessage("ready"); });
  pending.catch(() => { process.exitCode = 1; parentPort!.close(); });
});
