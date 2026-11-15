import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import type { MomentManifest, TraceEvent } from "@phoenix/formats";
import {
  answerCall, buildIndex, checkModelRequest, comparePrefixRequest, httpHost, httpShape, matchFrozen, mcpShape, replayCtx, sameReply, toCall,
  type Answer, type Call, type ConnectorPolicy, type Divergence, type ModelDialectName, type StartPoint, type WireMessage,
} from "@phoenix/answer";
import type { CaptureMetadata } from "@phoenix/store";
import { HTTP_STREAM, encodeHttpHead, httpGatewayTap, mcpStdioTap, type Backend, type Frame, type Link } from "@phoenix/taps";
import { VirtualClock } from "./clock.ts";
import { SampleTrace, streamName } from "./trace.ts";

export interface EngineOptions {
  evidence: { events: readonly TraceEvent[]; body(event: TraceEvent): Promise<Uint8Array> };
  connectors?: MomentManifest["connectors"];
  volatile?: Readonly<Record<string, readonly string[]>>;
  start: StartPoint;
  clock?: { start?: string };
  routes: { mcp?: Readonly<Record<string, string>>; http?: Readonly<Record<string, string>> };
  model?: { connector: string; dialect: ModelDialectName; provider: { url: string; headers: Readonly<Record<string, string>> } };
  sample: { root: string; metadata: CaptureMetadata };
  hmacKey: Uint8Array;
}

export type EngineStop = { kind: "diverged"; divergence: Divergence } | { kind: "interrupted"; why: string };

export interface Engine {
  backend: Backend;
  gateway: Server;
  clock: VirtualClock;
  accept(connection: { destination: { host: string; port: number }; stream: Duplex }): void;
  phase(): "prefix" | "live";
  prefixEdits(): { field: string }[];
  stopped: Promise<EngineStop>;
  close(): Promise<void>;
}

class Outbox {
  #queue: Frame[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  #error: Error | undefined;
  push(stream: number, bytes: Uint8Array, last: boolean): void {
    this.#queue.push({ dir: "back", stream, bytes, last, at: process.hrtime.bigint() });
    this.#wake?.();
  }
  end(): void { this.#done = true; this.#wake?.(); }
  fail(error: Error): void { this.#error ??= error; this.#wake?.(); }
  async *frames(): AsyncGenerator<Frame> {
    for (;;) {
      if (this.#error) throw this.#error;
      const next = this.#queue.shift();
      if (next) { yield next; continue; }
      if (this.#done) return;
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const header = (headers: readonly string[], name: string): string | undefined => {
  for (let i = 0; i + 1 < headers.length; i += 2) if (headers[i]!.toLowerCase() === name) return headers[i + 1];
  return undefined;
};

function encodeBody(bytes: Uint8Array, encoding: string | undefined): Uint8Array {
  let body = bytes;
  for (const e of (encoding ?? "identity").split(",").map(v => v.trim().toLowerCase())) {
    if (e === "gzip") body = gzipSync(body);
    else if (e === "deflate") body = deflateSync(body);
    else if (e === "br") body = brotliCompressSync(body);
    else if (e === "zstd") body = zstdCompressSync(body);
  }
  return body;
}

function withId(bytes: Uint8Array, id: unknown): Uint8Array {
  const message = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  if (JSON.stringify(message.id) === JSON.stringify(id)) return bytes;
  return Buffer.from(JSON.stringify({ ...message, id }) + "\n");
}

export async function startEngine(options: EngineOptions): Promise<Engine> {
  const policy = (connector: string): ConnectorPolicy => ({ ...options.connectors?.[connector], ...(options.volatile?.[connector] ? { volatile: options.volatile[connector] } : {}) });
  const index = await buildIndex(options.evidence.events, { body: options.evidence.body, policy, start: options.start, ...(options.clock?.start ? { startTime: options.clock.start } : {}) });
  const ctx = replayCtx(index, policy);
  const clock = new VirtualClock(index.startTime);
  const trace = await SampleTrace.create(options.sample.root, options.sample.metadata, clock, options.hmacKey);
  const edits = new Set<string>();
  const links = new Set<Outbox>();
  let live = false, linkCount = 0;
  let stop: EngineStop | undefined;
  let settle!: (value: EngineStop) => void;
  const stopped = new Promise<EngineStop>(resolve => { settle = resolve; });

  const halt = async (result: EngineStop): Promise<void> => {
    if (stop) return;
    stop = result;
    if (result.kind === "diverged")
      await trace.append("engine", { kind: "divergence", body: Buffer.from(JSON.stringify(result.divergence)), ...(result.divergence.call ? { connector: result.divergence.call.connector, op: result.divergence.call.op } : {}) }).catch(() => {});
    for (const link of links) link.fail(new Error(result.kind === "diverged" ? "Replay diverged" : "Replay interrupted"));
    settle(result);
  };
  const diverge = (divergence: Divergence) => halt({ kind: "diverged", divergence });
  const interrupt = (error: unknown) => halt({ kind: "interrupted", why: error instanceof Error ? error.message : String(error) });

  const goLiveIfDone = async (): Promise<void> => {
    if (live || !index.frozen.every(e => ctx.served.has(e.id))) return;
    live = true;
    clock.anchor(index.cutTime);
    await trace.append("engine", { kind: "meta", op: "start-point", body: Buffer.from(JSON.stringify({ prefix_edits: [...edits].sort().map(field => ({ field })) })) });
  };

  const respond = async (call: Call): Promise<Answer | undefined> => {
    if (stop) return undefined;
    if (!live) {
      const frozen = matchFrozen(call, ctx);
      if ("trigger" in frozen) { await diverge(frozen); return undefined; }
      return { raw: frozen.response, provenance: frozen.provenance, resolver: "frozen-prefix", exchange: frozen };
    }
    const result = await answerCall(call, ctx);
    if ("divergence" in result) { await diverge(result.divergence); return undefined; }
    return result.answer;
  };

  const opened = (): Outbox => {
    const out = new Outbox();
    links.add(out);
    if (stop) out.fail(new Error("Replay stopped"));
    return out;
  };

  const mcpLink = (connector: string): Link => {
    const out = opened();
    const stream = streamName("mcp", connector, String(linkCount++));
    const parts = new Map<number, Uint8Array[]>();
    const replies = new Map<string, (bytes: Uint8Array) => void>();
    let back = 0;
    let queue = Promise.resolve();
    const send = async (bytes: Uint8Array, answer: { provenance: Answer["provenance"]; resolver: string }) => {
      await trace.append(stream, { kind: "result", surface: "mcp", connector, op: mcpShape(bytes)?.op ?? "", body: bytes, provenance: answer.provenance, resolver: answer.resolver });
      out.push(back++, bytes, true);
    };
    const handle = async (bytes: Uint8Array): Promise<void> => {
      const shape = mcpShape(bytes);
      await trace.append(stream, { kind: "call", surface: "mcp", connector, op: shape?.op ?? "", body: bytes });
      if (!shape) return diverge({ trigger: "lifecycle", detail: `a message on ${connector} is not JSON-RPC` });
      if (!shape.message.method || !("id" in shape.message)) return;
      const call = toCall({ surface: "mcp", connector, op: shape.op!, args: shape.args, raw: { body: bytes } }, policy(connector));
      const answer = await respond(call);
      if (!answer) return;
      for (const during of answer.exchange?.during ?? []) {
        const message = mcpShape(during.message)?.message;
        const reply = during.reply && message && "id" in message ? new Promise<Uint8Array>(resolve => replies.set(JSON.stringify(message.id), resolve)) : undefined;
        await send(during.message, answer);
        if (reply && !sameReply(during.reply!, await reply))
          return diverge({ trigger: "lifecycle", detail: `the harness answered a server request during ${call.op} differently from the recording`, call: { connector, surface: "mcp", op: call.op, key: call.key } });
      }
      await send(withId(answer.raw.body, shape.message.id), answer);
      await goLiveIfDone();
    };
    return {
      async write(f) {
        if (f.stream < 0) return;
        const chunk = [...parts.get(f.stream) ?? [], f.bytes];
        if (!f.last) { parts.set(f.stream, chunk); return; }
        parts.delete(f.stream);
        const bytes = concat(chunk);
        if (!bytes.length) { queue = queue.then(() => out.end()); return; }
        const shape = mcpShape(bytes);
        const waiting = shape && !shape.message.method ? replies.get(JSON.stringify(shape.message.id)) : undefined;
        if (waiting) {
          replies.delete(JSON.stringify(shape!.message.id));
          await trace.append(stream, { kind: "call", surface: "mcp", connector, op: "", body: bytes });
          waiting(bytes);
          return;
        }
        queue = queue.then(() => handle(bytes)).catch(interrupt);
      },
      frames: () => out.frames(),
      abort: () => out.end(),
    };
  };

  const serveHttp = async (out: Outbox, stream: string, connector: string, raw: WireMessage, answer: { provenance: Answer["provenance"]; resolver: string; note?: string }) => {
    const head = raw.head!;
    await trace.append(stream, { kind: "meta", surface: "http", connector, head: { ...head } });
    await trace.append(stream, {
      kind: "result", surface: "http", connector, body: raw.body, provenance: answer.provenance, resolver: answer.resolver, contentType: header(head.headers, "content-type") ?? "",
      contentEncoding: raw.contentEncoding ? "identity" : header(head.headers, "content-encoding") ?? "identity", ...(raw.contentEncoding ? { decodedFrom: raw.contentEncoding } : {}),
    });
    out.push(HTTP_STREAM.responseHead, encodeHttpHead(head), true);
    out.push(HTTP_STREAM.responseBody, raw.contentEncoding ? encodeBody(raw.body, raw.contentEncoding) : raw.body, true);
  };

  const model = options.model;
  const modelExchange = async (out: Outbox, stream: string, request: { method: string; url: string; headers: readonly string[] }, body: Uint8Array): Promise<void> => {
    const path = new URL(request.url, "http://x").pathname;
    if (!live) {
      const candidates = index.frozen.filter(e => e.connector === model!.connector && !ctx.served.has(e.id) && e.request.head && e.request.head.method === request.method && new URL(e.request.head.url, "http://x").pathname === path);
      let first: { field: string; why: string } | undefined;
      for (const exchange of candidates) {
        const compared = comparePrefixRequest(model!.dialect, exchange.request.body, body);
        if (!compared.ok) { first ??= compared; continue; }
        ctx.served.add(exchange.id);
        compared.edits.forEach(field => edits.add(field));
        await serveHttp(out, stream, model!.connector, exchange.response, { provenance: exchange.provenance, resolver: "frozen-prefix" });
        await goLiveIfDone();
        return;
      }
      const next = index.frozen.find(e => !ctx.served.has(e.id));
      return diverge(first
        ? { trigger: "prefix-drift", detail: `model request differs from the recorded request at ${first.field}: ${first.why}`, field: first.field }
        : { trigger: "prefix-drift", detail: `model request ${request.method} ${path} where the recording has ${next ? `${next.op} on ${next.connector}` : "nothing"}` });
    }
    const refused = checkModelRequest(model!.dialect, request.method, path, body);
    if (refused) return diverge(refused);
    const target = new URL(model!.provider.url.replace(/\/$/, "") + new URL(request.url, "http://x").pathname + new URL(request.url, "http://x").search);
    const replaced = new Set(Object.keys(model!.provider.headers).map(n => n.toLowerCase()));
    const dropped = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "proxy-authorization"]);
    const headers: Record<string, string> = {};
    for (let i = 0; i + 1 < request.headers.length; i += 2) {
      const name = request.headers[i]!.toLowerCase();
      if (!replaced.has(name) && !dropped.has(name)) headers[name] = headers[name] === undefined ? request.headers[i + 1]! : `${headers[name]}, ${request.headers[i + 1]}`;
    }
    Object.assign(headers, model!.provider.headers, { "content-length": String(body.length) });
    const response = await new Promise<{ status: number; statusMessage: string; headers: string[]; body: Uint8Array }>((resolve, reject) => {
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(target, { method: request.method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, statusMessage: res.statusMessage ?? "", headers: res.rawHeaders, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
    const pairs: string[] = [];
    for (let i = 0; i + 1 < response.headers.length; i += 2) {
      const name = response.headers[i]!;
      if (["transfer-encoding", "connection", "keep-alive"].includes(name.toLowerCase())) continue;
      pairs.push(name, name.toLowerCase() === "date" ? clock.now().toUTCString() : response.headers[i + 1]!);
    }
    const head = { status: response.status, statusMessage: response.statusMessage, headers: pairs };
    await serveHttp(out, stream, model!.connector, { body: response.body, head }, { provenance: "real", resolver: "model-route" });
  };

  const httpLink = (connector: string, meta: { request: { method: string; url: string; headers: string[]; httpVersion: string } }): Link => {
    const out = opened();
    const stream = streamName(connector === model?.connector ? "model" : "http", connector || "unmapped", String(linkCount++));
    const parts: Uint8Array[] = [];
    const handle = async (body: Uint8Array): Promise<void> => {
      const request = meta.request;
      await trace.append(stream, { kind: "meta", surface: "http", connector, head: { ...request } });
      await trace.append(stream, { kind: "call", surface: "http", connector, op: `${request.method} ${new URL(request.url, "http://x").pathname}`, body, contentType: header(request.headers, "content-type") ?? "", contentEncoding: header(request.headers, "content-encoding") ?? "identity" });
      if (stop) return;
      if (!connector) return diverge({ trigger: "unmapped-connection", detail: `no connector is bound to host ${httpHost(request)}` });
      if (connector === model?.connector) return modelExchange(out, stream, request, body);
      const shape = httpShape(request, body);
      const call = toCall({ surface: "http", connector, op: shape.op, args: shape.args, raw: { body, head: request } }, policy(connector));
      const answer = await respond(call);
      if (!answer) return;
      await serveHttp(out, stream, connector, answer.raw, answer);
      await goLiveIfDone();
    };
    return {
      async write(f) {
        if (f.stream !== HTTP_STREAM.requestBody) return;
        parts.push(f.bytes);
        if (f.last) handle(concat(parts)).catch(error => { out.fail(error); return interrupt(error); });
      },
      frames: () => out.frames(),
      abort: () => out.end(),
    };
  };

  const backend: Backend = {
    open({ surface, connector, meta }) {
      const m = meta as { transport?: string; request?: { method: string; url: string; headers: string[]; httpVersion: string } };
      if (surface === "mcp" && m.transport === "stdio") return mcpLink(connector);
      if (m.transport === "http" && m.request && surface === "http") return httpLink(connector, { request: m.request });
      const out = opened();
      void diverge({ trigger: "unmapped-connection", detail: `the engine has no responder for ${surface} connections on ${connector}` });
      return { write: async () => {}, frames: () => out.frames(), abort: () => out.end() };
    },
  };
  const gateway = httpGatewayTap({ backend, route: request => ({ surface: "http", connector: options.routes.http?.[httpHost(request)] ?? "" }) });
  if (!index.frozen.length) await goLiveIfDone();

  return {
    backend, gateway, clock, stopped,
    accept({ destination, stream }) {
      const connector = options.routes.mcp?.[destination.host];
      if (!connector) { gateway.emit("connection", stream); return; }
      mcpStdioTap({ backend, connector, io: { stdin: stream, stdout: stream, stderr: new PassThrough() } }).then(() => stream.end(), () => stream.destroy());
    },
    phase: () => live ? "live" : "prefix",
    prefixEdits: () => [...edits].sort().map(field => ({ field })),
    async close() { await trace.close(); },
  };
}
