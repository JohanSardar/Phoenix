import type { TraceEvent } from "@phoenix/formats";
import { stripSecrets } from "@phoenix/redact";
import { decodeHttpBody } from "@phoenix/taps";
import { BlobStore, createCapture, createTraceWriter, type CaptureMetadata, type TraceWriter } from "@phoenix/store";
import type { VirtualClock } from "./clock.ts";

const INLINE_LIMIT = 64 * 1024;

export interface TraceEntry {
  kind: TraceEvent["kind"];
  surface?: TraceEvent["surface"];
  layer?: TraceEvent["layer"];
  connector?: string;
  op?: string;
  body?: Uint8Array;
  head?: { headers: readonly string[]; url?: string; [key: string]: unknown };
  contentEncoding?: string;
  decodedFrom?: string;
  contentType?: string;
  provenance?: TraceEvent["provenance"];
  resolver?: string;
  afterUntakenWrite?: boolean;
  chunks?: TraceEvent["chunks"];
}

const text = (bytes: Uint8Array): string | undefined => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
};

export function streamName(...parts: string[]): string {
  return parts.map(p => p.replace(/[^a-zA-Z0-9_-]/g, "_")).join(".");
}

export class SampleTrace {
  readonly #writers = new Map<string, { writer: TraceWriter; seq: number; tail: Promise<unknown> }>();
  readonly #root: string;
  readonly #capture: string;
  readonly #clock: VirtualClock;
  readonly #hmacKey: Uint8Array;
  readonly #blobs: BlobStore;

  private constructor(root: string, capture: string, clock: VirtualClock, hmacKey: Uint8Array) {
    this.#root = root; this.#capture = capture; this.#clock = clock; this.#hmacKey = hmacKey;
    this.#blobs = new BlobStore(root);
  }

  static async create(root: string, metadata: CaptureMetadata, clock: VirtualClock, hmacKey: Uint8Array): Promise<SampleTrace> {
    await createCapture(root, metadata);
    return new SampleTrace(root, metadata.capture, clock, hmacKey);
  }

  append(stream: string, entry: TraceEntry): Promise<string> {
    let slot = this.#writers.get(stream);
    if (!slot) {
      slot = { writer: createTraceWriter(this.#root, { capture: this.#capture, stream }), seq: 0, tail: Promise.resolve() };
      this.#writers.set(stream, slot);
    }
    const ts = { wall: this.#clock.now().toISOString(), mono: process.hrtime.bigint().toString() };
    const written = slot.tail.then(() => this.#write(slot, stream, entry, ts));
    slot.tail = written.catch(() => {});
    return written;
  }

  async #write(slot: { writer: TraceWriter; seq: number }, stream: string, entry: TraceEntry, ts: TraceEvent["ts"]): Promise<string> {
    const seq = slot.seq++;
    const id = `${stream}:${seq}`;
    const event: TraceEvent = {
      v: 1, capture: this.#capture, stream, seq, id, kind: entry.kind, route: "tap",
      ts,
      ...(entry.surface ? { surface: entry.surface, layer: entry.layer ?? "agent" as const } : {}),
      ...(entry.connector !== undefined ? { connector: entry.connector } : {}),
      ...(entry.op ? { op: entry.op } : {}),
      ...(entry.provenance ? { provenance: entry.provenance } : {}),
      ...(entry.resolver ? { resolver: entry.resolver } : {}),
      ...(entry.afterUntakenWrite ? { after_untaken_write: true } : {}),
      ...(entry.chunks ? { chunks: entry.chunks } : {}),
    };
    if (entry.head) {
      const grouped: Record<string, string[]> = {};
      for (let i = 0; i + 1 < entry.head.headers.length; i += 2) (grouped[entry.head.headers[i]!] ??= []).push(entry.head.headers[i + 1]!);
      const { msg } = await stripSecrets({ headers: grouped, ...(entry.head.url !== undefined ? { url: entry.head.url } : {}) }, { hmacKey: this.#hmacKey });
      const used: Record<string, number> = {};
      const headers = entry.head.headers.map((value, i) => {
        if (i % 2 === 0) return value;
        const name = entry.head!.headers[i - 1]!;
        return (msg.headers![name] as readonly string[])[used[name] = (used[name] ?? -1) + 1]!;
      });
      event.body = { inline: JSON.stringify({ ...entry.head, headers, ...(msg.url !== undefined ? { url: msg.url } : {}) }) };
      if (msg.secrets) event.secrets = msg.secrets;
    } else if (entry.body) {
      const decoded = decodeHttpBody(entry.body, ["content-encoding", entry.contentEncoding ?? "identity"]);
      if (!decoded.ok) throw new Error(`Cannot decode sample trace body: ${decoded.why}`);
      const { msg, originalEncoding } = await stripSecrets({
        body: decoded.value,
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
      }, { hmacKey: this.#hmacKey });
      const bytes = msg.body ?? entry.body;
      const inline = bytes.length <= INLINE_LIMIT ? text(bytes) : undefined;
      event.body = inline !== undefined ? { inline } : { blob: await this.#blobs.put(bytes) };
      const encoding = originalEncoding ?? entry.decodedFrom ?? entry.contentEncoding;
      if (encoding && encoding !== "identity") event.body.content_encoding = encoding;
      if (msg.secrets) event.secrets = msg.secrets;
    }
    if (slot.writer.append(event) !== "queued") throw new Error(`Sample trace dropped an event on ${stream}`);
    await slot.writer.drain();
    return id;
  }

  async close(): Promise<void> {
    for (const { writer, tail } of this.#writers.values()) { await tail; await writer.close(); }
    this.#writers.clear();
  }
}
