import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import type { MomentManifest, PluginDescriptor, TraceEvent } from "@phoenix/formats";
import {
  answerCall, buildIndex, checkModelRequest, comparePrefixRequest, httpHost, httpShape, matchFrozen, mcpShape, modelInferencePath, replayCtx, sameReply, selectModelRequest, toCall,
  Emulators, type EmulatorConfig, type Answer, type Call, type ConnectorPolicy, type Divergence, type Exchange, type ModelDialectName, type SimulatorOptions, type StartPoint, type WireMessage,
} from "@phoenix/answer";
import type { CaptureMetadata } from "@phoenix/store";
import { HTTP_STREAM, decodeCliInvocation, encodeHttpHead, httpGatewayTap, mcpStdioTap, type Backend, type Link } from "@phoenix/taps";
import { VirtualClock } from "./clock.ts";
import { SampleTrace, streamName } from "./trace.ts";
import { cliRelay, cliResponder } from "./cli.ts";
import { mcpHttpResponder } from "./mcp-http.ts";
import { Outbox, type Responder } from "./responder.ts";

export interface EngineOptions {
  emulators?: readonly EmulatorConfig[];
  simulator?: Omit<SimulatorOptions, "clock">;
  evidence: { events: readonly TraceEvent[]; body(event: TraceEvent): Promise<Uint8Array> };
  resume?: EngineOptions["evidence"] | readonly EngineOptions["evidence"][];
  connectors?: MomentManifest["connectors"];
  volatile?: Readonly<Record<string, readonly string[]>>;
  entityMaps?: Readonly<Record<string, PluginDescriptor["entity_map"]>>;
  start: StartPoint;
  clock?: { start?: string };
  routes: { mcp?: Readonly<Record<string, string>>; cli?: Readonly<Record<string, string>>; http?: Readonly<Record<string, string>>; mcpHttp?: Readonly<Record<string, string>> };
  model?: { connector: string; dialect: ModelDialectName; provider: { url: string; headers: Readonly<Record<string, string>> }; selection?: { id: string; parameters?: Readonly<Record<string, unknown>> } };
  sample: { root: string; metadata: CaptureMetadata };
  hmacKey: Uint8Array;
}

export type EngineStop = { kind: "diverged"; divergence: Divergence } | { kind: "interrupted"; why: string };

export interface Engine {
  state(connector: string): Promise<unknown>;
  backend: Backend;
  gateway: Server;
  clock: VirtualClock;
  accept(connection: { destination: { host: string; port: number }; stream: Duplex }): void;
  phase(): "prefix" | "live";
  prefixComplete(): boolean;
  prefixEdits(): { field: string }[];
  stopped: Promise<EngineStop>;
  close(): Promise<void>;
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
  const policy = (connector: string): ConnectorPolicy => ({ ...options.connectors?.[connector], entity_map: options.entityMaps?.[connector], ...(options.volatile?.[connector] ? { volatile: options.volatile[connector] } : {}) });
  const original = await buildIndex(options.evidence.events, { body: options.evidence.body, policy, start: options.start, ...(options.clock?.start ? { startTime: options.clock.start } : {}) });
  const resumes = options.resume ? "events" in options.resume ? [options.resume] : options.resume : [];
  const recoveryIndexes = await Promise.all(resumes.map(resume => buildIndex(resume.events, { body: resume.body, policy, start: "echo", startTime: original.startTime })));
  const recovery = recoveryIndexes.reduce<typeof recoveryIndexes[number] | undefined>((longest, next) => !longest || next.frozen.length > longest.frozen.length ? next : longest, undefined);
  const recovered = new Map<string, Exchange>();
  const covered = new Set<string>();
  let recoveryPrefix = "resume:";
  while (original.exchanges.some(e => e.id.startsWith(recoveryPrefix))) recoveryPrefix = `resume:${recoveryPrefix}`;
  const recoveryFrozen = (recovery?.frozen ?? []).map(exchange => {
    const matched = original.exchanges.find(e => {
      if (covered.has(e.id)) return false;
      if (e.key === exchange.key && e.history.length === exchange.history.length && e.history.every((key, i) => key === exchange.history[i])) return true;
      if (!options.model || e.connector !== options.model.connector || exchange.connector !== e.connector || !e.request.head || !exchange.request.head) return false;
      return e.request.head.method === exchange.request.head.method
        && new URL(e.request.head.url, "http://x").pathname === new URL(exchange.request.head.url, "http://x").pathname
        && comparePrefixRequest(options.model.dialect, e.request.body, exchange.request.body).ok;
    });
    const id = `${recoveryPrefix}${exchange.id}`;
    if (matched) { recovered.set(id, matched); covered.add(matched.id); }
    return { ...exchange, id, response: { ...exchange.response, ...(exchange.response.chunks ? { chunks: exchange.response.chunks.map(chunk => ({ ...chunk, waitFor: chunk.waitFor.map(id => `${recoveryPrefix}${id}`) })) } : {}) } };
  });
  const notifications = new Map(original.notifications);
  for (const [connector, methods] of recovery?.notifications ?? []) notifications.set(connector, new Set([...(notifications.get(connector) ?? []), ...methods]));
  const index = { ...original, frozen: [...recoveryFrozen, ...original.frozen.filter(e => !covered.has(e.id))], notifications };
  const clock = new VirtualClock(index.startTime);
  const trace = await SampleTrace.create(options.sample.root, options.sample.metadata, clock, options.hmacKey);
  let emulators: Emulators;
  try {
    emulators = await Emulators.start((options.emulators ?? []).filter(c => !policy(c.plugin.descriptor.connector).skip_resolvers?.includes("emulator")), () => clock.now(), async difference => {
      await trace.append("engine", { kind: "meta", connector: difference.connector, op: "fidelity.emulator_differences", body: Buffer.from(JSON.stringify(difference)) });
    });
  } catch (error) { await trace.close(); throw error; }
  const ctx = replayCtx(index, policy, emulators, options.simulator ? { ...options.simulator, clock: () => index.cutTime } : undefined);
  const completed = new Set<string>();
  const edits = new Set<string>();
  for (const resume of resumes) for (const event of resume.events) if (event.op === "start-point" && event.kind === "meta") {
    const previous = JSON.parse(Buffer.from(await resume.body(event)).toString()) as { prefix_edits?: { field: string }[] };
    previous.prefix_edits?.forEach(edit => edits.add(edit.field));
  }
  const links = new Set<Outbox>();
  let live = false, linkCount = 0;
  let startMarked = false, resumeMarked = false;
  const changed = new Set<() => void>();
  const mcpHttpIds = new Map<string, Map<string, string>>();
  let stop: EngineStop | undefined;
  let settle!: (value: EngineStop) => void;
  const stopped = new Promise<EngineStop>(resolve => { settle = resolve; });

  const halt = async (result: EngineStop): Promise<void> => {
    if (stop) return;
    stop = result;
    if (result.kind === "diverged")
      await trace.append("engine", { kind: "divergence", body: Buffer.from(JSON.stringify(result.divergence)), ...(result.divergence.call ? { connector: result.divergence.call.connector, op: result.divergence.call.op } : {}) }).catch(() => {});
    for (const link of links) link.fail(new Error(result.kind === "diverged" ? "Replay diverged" : "Replay interrupted"));
    for (const wake of changed) wake();
    settle(result);
  };
  const diverge = (divergence: Divergence) => halt({ kind: "diverged", divergence });
  const interrupt = (error: unknown) => halt({ kind: "interrupted", why: error instanceof Error ? error.message : String(error) });

  const goLiveIfDone = async (): Promise<void> => {
    if (!startMarked && options.start !== "echo" && original.frozen.every(e => completed.has(e.id))) {
      startMarked = true;
      await trace.append("engine", { kind: "meta", op: "start-point", body: Buffer.from(JSON.stringify({ prefix_edits: [...edits].sort().map(field => ({ field })) })) });
    }
    if (recovery && !resumeMarked && recoveryFrozen.every(e => completed.has(e.id))) {
      resumeMarked = true;
      await trace.append("engine", { kind: "meta", op: "resume-point", body: Buffer.from(JSON.stringify({ recovered: recoveryFrozen.length })) });
    }
    if (live || options.start === "echo" || !index.frozen.every(e => completed.has(e.id))) return;
    live = true;
    clock.anchor(recovery && original.frozen.every(e => covered.has(e.id)) ? [...recoveryFrozen].sort((a, b) => a.completed - b.completed).at(-1)?.observedAt ?? index.cutTime : index.cutTime);
  };

  const accepted = (answer: Answer): Answer => {
    const originalExchange = answer.exchange && recovered.get(answer.exchange.id);
    if (originalExchange) ctx.served.add(originalExchange.id);
    for (const wake of changed) wake();
    return answer;
  };

  const advance = async (answer: Answer): Promise<void> => {
    if (answer.exchange) {
      completed.add(answer.exchange.id);
      const originalExchange = recovered.get(answer.exchange.id);
      if (originalExchange) completed.add(originalExchange.id);
    }
    await goLiveIfDone();
  };

  const respond = async (call: Call): Promise<Answer | undefined> => {
    if (stop) return undefined;
    if (!live) {
      const frozen = matchFrozen(call, ctx);
      if ("trigger" in frozen) { await diverge(frozen); return undefined; }
      const answer = { raw: frozen.response, provenance: frozen.provenance, resolver: "frozen-prefix", exchange: frozen };
      const difference = await emulators.observe(call, answer, frozen.observedAt);
      if (difference && !call.readOnly && frozen.id.startsWith(recoveryPrefix)) {
        await diverge({ trigger: "prefix-drift", detail: `a recovered write on ${call.connector} returned a different emulator response`, call: { connector: call.connector, surface: call.surface, op: call.op, key: call.key } });
        return undefined;
      }
      return accepted(answer);
    }
    const result = await answerCall(call, ctx);
    if ("divergence" in result) { await diverge(result.divergence); return undefined; }
    return accepted(result.answer);
  };

  const opened = (): Outbox => {
    const out = new Outbox();
    links.add(out);
    if (stop) out.fail(new Error("Replay stopped"));
    return out;
  };

  const responder = (surface: string, connector: string): Responder => ({
    connector, stream: streamName(surface, connector, String(linkCount++)), out: opened(), trace, policy: policy(connector),
    history: () => ctx.histories[connector] ?? [], respond, advance, diverge, interrupt,
  });
  const waitFor = async (ids: readonly string[]): Promise<boolean> => {
    while (!stop && !ids.every(id => ctx.served.has(id))) await new Promise<void>(resolve => {
      const wake = () => { changed.delete(wake); resolve(); };
      changed.add(wake);
    });
    return !stop;
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
    const handle = async (bytes: Uint8Array, history: readonly string[]): Promise<void> => {
      const shape = mcpShape(bytes);
      await trace.append(stream, { kind: "call", surface: "mcp", connector, op: shape?.op ?? "", body: bytes });
      if (!shape) return diverge({ trigger: "lifecycle", detail: `a message on ${connector} is not JSON-RPC` });
      if (!shape.message.method) return;
      if (!("id" in shape.message)) {
        if (index.notifications.get(connector)?.has(shape.message.method)) return;
        return diverge({ trigger: "lifecycle", detail: `the recording of ${connector} never has the harness send ${shape.message.method}` });
      }
      const call = { ...toCall({ surface: "mcp", connector, op: shape.op!, args: shape.args, raw: { body: bytes } }, policy(connector)), history };
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
      for (const message of answer.exchange?.after ?? []) await send(message, answer);
      await advance(answer);
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
        const history = ctx.histories[connector] ?? [];
        queue = queue.then(() => handle(bytes, history)).catch(interrupt);
      },
      frames: () => out.frames(),
      abort: () => out.end(),
    };
  };

  const serveHttp = async (out: Outbox, stream: string, connector: string, raw: WireMessage, answer: { provenance: Answer["provenance"]; resolver: string; note?: string }, op: string) => {
    const wire = raw.contentEncoding ? encodeBody(raw.body, raw.contentEncoding) : raw.body;
    const head = { ...raw.head!, headers: raw.head!.headers.map((value, i) => i % 2 === 1 && raw.head!.headers[i - 1]!.toLowerCase() === "content-length" ? String(wire.length) : value) };
    await trace.append(stream, { kind: "meta", surface: "http", connector, head });
    await trace.append(stream, {
      kind: "result", surface: "http", connector, op, body: raw.body, provenance: answer.provenance, resolver: answer.resolver, contentType: header(head.headers, "content-type") ?? "",
      contentEncoding: raw.contentEncoding ? "identity" : header(head.headers, "content-encoding") ?? "identity", ...(raw.contentEncoding ? { decodedFrom: raw.contentEncoding } : {}),
    });
    out.push(HTTP_STREAM.responseHead, encodeHttpHead(head), true);
    out.push(HTTP_STREAM.responseBody, wire, true);
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
        const answer = accepted({ raw: exchange.response, provenance: exchange.provenance, resolver: "frozen-prefix", exchange });
        compared.edits.forEach(field => edits.add(field));
        await serveHttp(out, stream, model!.connector, exchange.response, { provenance: exchange.provenance, resolver: "frozen-prefix" }, `${request.method} ${modelInferencePath(model!.dialect, path)}`);
        await advance(answer);
        return;
      }
      const next = index.frozen.find(e => !ctx.served.has(e.id));
      return diverge(first
        ? { trigger: "prefix-drift", detail: `model request differs from the recorded request at ${first.field}: ${first.why}`, field: first.field }
        : { trigger: "prefix-drift", detail: `model request ${request.method} ${path} where the recording has ${next ? `${next.op} on ${next.connector}` : "nothing"}` });
    }
    const selected = model!.selection ? selectModelRequest(model!.dialect, path, body, model!.selection) : { path, body };
    body = selected.body;
    const refused = checkModelRequest(model!.dialect, request.method, selected.path, body);
    if (refused) return diverge(refused);
    const target = new URL(model!.provider.url.replace(/\/$/, "") + selected.path + new URL(request.url, "http://x").search);
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
    if (response.status === 429 || response.status >= 500) throw new Error(`Model provider returned HTTP ${response.status}`);
    const pairs: string[] = [];
    for (let i = 0; i + 1 < response.headers.length; i += 2) {
      const name = response.headers[i]!;
      if (["transfer-encoding", "connection", "keep-alive"].includes(name.toLowerCase())) continue;
      pairs.push(name, name.toLowerCase() === "date" ? clock.now().toUTCString() : response.headers[i + 1]!);
    }
    const head = { status: response.status, statusMessage: response.statusMessage, headers: pairs };
    await serveHttp(out, stream, model!.connector, { body: response.body, head }, { provenance: "real", resolver: "model-route" }, `${request.method} ${modelInferencePath(model!.dialect, path)}`);
  };

  const httpLink = (connector: string, meta: { request: { method: string; url: string; headers: string[]; httpVersion: string } }): Link => {
    const out = opened();
    const stream = streamName(connector === model?.connector ? "model" : "http", connector || "unmapped", String(linkCount++));
    const parts: Uint8Array[] = [];
    const handle = async (body: Uint8Array): Promise<void> => {
      const request = meta.request;
      await trace.append(stream, { kind: "meta", surface: "http", connector, head: { ...request } });
      const path = new URL(request.url, "http://x").pathname;
      await trace.append(stream, { kind: "call", surface: "http", connector, op: `${request.method} ${connector === model?.connector ? modelInferencePath(model.dialect, path) : path}`, body, contentType: header(request.headers, "content-type") ?? "", contentEncoding: header(request.headers, "content-encoding") ?? "identity" });
      if (stop) return;
      if (!connector) return diverge({ trigger: "unmapped-connection", detail: `no connector is bound to host ${httpHost(request)}` });
      if (connector === model?.connector) return modelExchange(out, stream, request, body);
      const shape = httpShape(request, body);
      const call = toCall({ surface: "http", connector, op: shape.op, args: shape.args, raw: { body, head: request } }, policy(connector));
      const answer = await respond(call);
      if (!answer) return;
      await serveHttp(out, stream, connector, answer.raw, answer, call.op);
      await advance(answer);
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
      if (surface === "cli") {
        try { return cliResponder({ ...responder("cli", connector), invocation: decodeCliInvocation(Buffer.from(JSON.stringify(meta))) }); }
        catch { void diverge({ trigger: "lifecycle", detail: `invalid CLI invocation on ${connector}` }); }
      }
      if (surface === "mcp" && m.transport === "http" && m.request) {
        const ids = mcpHttpIds.get(connector) ?? new Map<string, string>();
        mcpHttpIds.set(connector, ids);
        return mcpHttpResponder({ ...responder("mcp-http", connector), request: m.request, ids, waitFor });
      }
      if (m.transport === "http" && m.request && surface === "http") return httpLink(connector, { request: m.request });
      const out = opened();
      void diverge({ trigger: "unmapped-connection", detail: `the engine has no responder for ${surface} connections on ${connector}` });
      return { write: async () => {}, frames: () => out.frames(), abort: () => out.end() };
    },
  };
  const gateway = httpGatewayTap({ backend, route: request => {
    const path = new URL(request.url, "http://x").pathname;
    const connector = options.routes.mcpHttp?.[path];
    return connector ? { surface: "mcp", connector } : { surface: "http", connector: options.routes.http?.[httpHost(request)] ?? "" };
  } });
  await goLiveIfDone();

  return {
    state: connector => emulators.state(connector),
    backend, gateway, clock, stopped,
    accept({ destination, stream }) {
      const cli = options.routes.cli?.[destination.host];
      if (cli) { void cliRelay(stream, backend, cli).catch(error => { stream.destroy(); return diverge({ trigger: "lifecycle", detail: error instanceof Error ? error.message : String(error) }); }); return; }
      const connector = options.routes.mcp?.[destination.host];
      if (!connector) { gateway.emit("connection", stream); return; }
      mcpStdioTap({ backend, connector, io: { stdin: stream, stdout: stream, stderr: new PassThrough() } }).then(() => stream.end(), () => stream.destroy());
    },
    phase: () => live ? "live" : "prefix",
    prefixComplete: () => index.frozen.every(e => completed.has(e.id)),
    prefixEdits: () => [...edits].sort().map(field => ({ field })),
    async close() { try { await emulators.close(); } finally { await trace.close(); } },
  };
}
