import { mkdir, open, readFile, readdir, unlink, link, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { TraceEvent, WorkdirSnapshot } from "@phoenix/formats";
import { atomicWrite, checked, digest, syncDirectory, writeAll } from "./io.ts";

export interface CaptureMetadata {
  capture: string;
  harness: { name: string; tree: string };
  recipe: { name: string; version: string };
  routes: string[];
  task_key?: unknown;
  started_at: string;
  boot_id: string;
}

export async function createCapture(root: string, metadata: CaptureMetadata): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const dir of ["seg", "import", "workdir", "blobs/sha256", "blobs/tmp"])
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  const file = await open(join(root, "capture.json"), "wx", 0o600);
  try { await writeAll(file, Buffer.from(JSON.stringify(metadata) + "\n")); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(join(root, "blobs"));
  await syncDirectory(root);
  await syncDirectory(dirname(root));
}

export async function appendCoverage(root: string, coverage: unknown): Promise<void> {
  const file = await open(join(root, "coverage.jsonl"), "a", 0o600);
  try { await writeAll(file, Buffer.from(JSON.stringify(coverage) + "\n")); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(root);
}

const fileKey = (key: string) => {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(key)) throw new Error("Invalid stream or file key");
  return key;
};

export interface TraceWriter {
  append(event: TraceEvent): "queued" | "dropped";
  drain(): Promise<void>;
  close(): Promise<void>;
}

export function createTraceWriter(root: string, options: {
  capture: string; stream: string; maxQueuedBytes?: number; retryMs?: number;
  onError?: (code: string) => void;
}): TraceWriter {
  fileKey(options.stream);
  const queue: { event: TraceEvent; bytes: Buffer }[] = [];
  let queuedBytes = 0, generation = 0, lastSeq = -1, gapSequence = 0;
  let file: FileHandle | undefined;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false, failures = 0;
  const lost: NonNullable<TraceEvent["dropped"]>[] = [];
  const countRange = (range: NonNullable<TraceEvent["dropped"]>) => {
    lost.push(range);
    lost.sort((a, b) => a.from - b.from);
    for (let i = 1; i < lost.length;) {
      const previous = lost[i - 1]!, next = lost[i]!;
      if (next.from <= previous.to + 1) {
        previous.to = Math.max(previous.to, next.to);
        previous.bytes += next.bytes;
        lost.splice(i, 1);
      } else i++;
    }
  };
  const count = (event: TraceEvent, bytes: number) => {
    countRange({ from: event.seq, to: event.seq, bytes });
  };
  const connect = async () => {
    await mkdir(join(root, "seg"), { recursive: true, mode: 0o700 });
    while (!file) {
      const path = join(root, "seg", `${options.stream}.${generation++}.jsonl`);
      try { file = await open(path, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    gapSequence = 0;
    await syncDirectory(join(root, "seg"));
  };
  const stamp = (kind: "gap" | "close", seq: number): TraceEvent => ({
    v: 1, capture: options.capture, stream: options.stream, seq,
    ts: { wall: new Date().toISOString(), mono: process.hrtime.bigint().toString() }, kind,
  });
  const pump = async () => {
    try {
      if (!file) await connect();
      while (lost.length || queue.length) {
        if (lost[0] && (!queue[0] || lost[0].from < queue[0].event.seq)) {
          const range = lost.shift()!;
          try {
            const gap = { ...stamp("gap", gapSequence++), stream: `${options.stream}.recovery.${generation - 1}`, dropped: range, body: { inline: JSON.stringify({ stream: options.stream }) } };
            await writeAll(file!, Buffer.from(JSON.stringify(gap) + "\n"));
            await file!.sync();
          } catch (error) { countRange(range); throw error; }
        }
        const item = queue[0];
        if (!item) continue;
        try {
          await writeAll(file!, item.bytes);
          await file!.sync();
        } catch (error) { count(item.event, item.bytes.length); throw error; }
        finally { queue.shift(); queuedBytes -= item.bytes.length; }
      }
    } catch (error) {
      await file?.close().catch(() => {});
      file = undefined;
      for (const item of queue.splice(0)) count(item.event, item.bytes.length);
      queuedBytes = 0;
      failures++;
      try { options.onError?.((error as NodeJS.ErrnoException).code ?? "WRITE_FAILED"); } catch {}
      if (closing) throw new Error("Trace write failed while closing");
      timer = setTimeout(start, options.retryMs ?? 1000);
      timer.unref();
    }
  };
  const start = () => {
    timer = undefined;
    active = pump().finally(() => { active = undefined; });
  };
  return {
    append(event) {
      if (closing) throw new Error("Trace writer is closed");
      checked("trace", event);
      if (event.capture !== options.capture || event.stream !== options.stream) throw new Error("Event belongs to another stream");
      if (event.seq <= lastSeq) throw new Error("Stream sequence must increase");
      lastSeq = event.seq;
      const bytes = Buffer.from(JSON.stringify(event) + "\n");
      if (queuedBytes + bytes.length > (options.maxQueuedBytes ?? 1024 * 1024)) {
        count(event, bytes.length);
        if (!active && !timer) start();
        return "dropped";
      }
      queue.push({ event: JSON.parse(bytes.toString()) as TraceEvent, bytes });
      queuedBytes += bytes.length;
      if (!active && !timer) start();
      return "queued";
    },
    async drain() {
      const before = failures;
      while (active) await active;
      if (failures !== before || timer) throw new Error("Trace write failed; queued events were dropped");
    },
    async close() {
      if (closing) throw new Error("Trace writer is already closed");
      closing = true;
      if (timer) clearTimeout(timer);
      try {
        await active;
        await pump();
        const event = stamp("close", lastSeq + 1);
        await writeAll(file!, Buffer.from(JSON.stringify(event) + "\n"));
        await file!.sync();
      } finally { await file?.close(); file = undefined; }
    },
  };
}

export async function appendNote(root: string, event: TraceEvent): Promise<void> {
  checked("trace", event);
  if (!["mark", "task", "correction"].includes(event.kind)) throw new Error("Not a note event");
  const file = await open(join(root, "notes.jsonl"), "a", 0o600);
  try { await writeAll(file, Buffer.from(JSON.stringify(event) + "\n")); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(root);
}

export async function writeSnapshot(root: string, run: string, snapshot: WorkdirSnapshot): Promise<void> {
  checked("workdir", snapshot);
  await atomicWrite(join(root, "workdir", `${fileKey(run)}.json`), JSON.stringify(snapshot) + "\n");
}

export async function writeImport(root: string, reader: string, sourceDigest: string, events: readonly TraceEvent[]): Promise<boolean> {
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) throw new Error("Invalid source digest");
  for (const event of events) {
    checked("trace", event);
    if (event.route !== "import" && event.route !== "transcript") throw new Error("Not an imported event");
  }
  const dir = join(root, "import");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  await atomicWrite(temp, events.map((e) => JSON.stringify(e) + "\n").join(""));
  try {
    await link(temp, join(dir, `${fileKey(reader)}.${sourceDigest.slice(7)}.jsonl`));
    await syncDirectory(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { await unlink(temp); }
}

export class BlobStore {
  root: string;
  constructor(captureRoot: string) { this.root = join(captureRoot, "blobs"); }
  path(hash: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid blob digest");
    return join(this.root, "sha256", hash.slice(7));
  }
  async put(bytes: Uint8Array): Promise<string> {
    const hash = digest(bytes);
    await atomicWrite(this.path(hash), bytes);
    return hash;
  }
  async get(hash: string): Promise<Uint8Array> {
    const bytes = await readFile(this.path(hash));
    if (digest(bytes) !== hash) throw new Error(`Blob digest mismatch: ${hash}`);
    return bytes;
  }
  async spool(event: TraceEvent): Promise<BlobSpool> {
    checked("trace", event);
    const id = randomUUID(), dir = join(this.root, "tmp", id), stage = join(this.root, "tmp", `.${id}`);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await atomicWrite(join(stage, "event.json"), JSON.stringify(event));
    const file = await open(join(stage, "body"), "wx", 0o600);
    await file.sync();
    await syncDirectory(stage);
    await rename(stage, dir);
    await syncDirectory(join(this.root, "tmp"));
    return new BlobSpool(this, dir, file, event);
  }
  async recoverSpools(): Promise<{ event: TraceEvent; spool: string }[]> {
    const recovered: { event: TraceEvent; spool: string }[] = [];
    const dirs = await readdir(join(this.root, "tmp"), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return []; throw e;
    });
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
      const path = join(this.root, "tmp", dir.name);
      const event = checked("trace", JSON.parse(await readFile(join(path, "event.json"), "utf8")));
      const bytes = await readFile(join(path, "body")).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return event.body && "blob" in event.body ? Buffer.from(await this.get(event.body.blob)) : Buffer.alloc(0);
      });
      const chunks: NonNullable<TraceEvent["chunks"]> = [];
      const lines = await readFile(join(path, "chunks.jsonl"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; });
      const rows = lines.split("\n");
      if (rows.at(-1) === "") rows.pop();
      for (let i = 0; i < rows.length; i++) {
        let chunk: { offset: number; at: string };
        try { chunk = JSON.parse(rows[i]!); }
        catch { if (i === rows.length - 1) break; throw new Error(`Corrupt spool chunk log: ${dir.name}`); }
        if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !/^\d+$/.test(chunk.at)) throw new Error(`Invalid spool chunk: ${dir.name}`);
        if (chunk.offset <= bytes.length) chunks.push(chunk);
      }
      recovered.push({ spool: dir.name, event: { ...event, body: { blob: await this.put(bytes), ...("content_encoding" in (event.body ?? {}) ? { content_encoding: event.body!.content_encoding } : {}) }, chunks, partial: true } });
    }
    return recovered;
  }
}

export class BlobSpool {
  private store: BlobStore;
  private dir: string;
  private file: FileHandle;
  private event: TraceEvent;
  private offset = 0;
  private chunks: NonNullable<TraceEvent["chunks"]> = [];
  private ended = false;
  constructor(store: BlobStore, dir: string, file: FileHandle, event: TraceEvent) {
    this.store = store; this.dir = dir; this.file = file; this.event = event;
  }
  async append(bytes: Uint8Array, at: string): Promise<void> {
    if (this.ended) throw new Error("Spool is closed");
    if (!/^\d+$/.test(at)) throw new Error("Invalid chunk timestamp");
    await writeAll(this.file, bytes);
    await this.file.sync();
    const chunk = { offset: this.offset, at };
    const log = await open(join(this.dir, "chunks.jsonl"), "a", 0o600);
    try { await writeAll(log, Buffer.from(JSON.stringify(chunk) + "\n")); await log.sync(); }
    finally { await log.close(); }
    this.chunks.push(chunk);
    this.offset += bytes.length;
  }
  async finish(): Promise<TraceEvent> {
    if (this.ended) throw new Error("Spool is closed");
    this.ended = true;
    await this.file.sync();
    await this.file.close();
    const bytes = await readFile(join(this.dir, "body"));
    const blob = digest(bytes);
    const event: TraceEvent = { ...this.event, body: { ...this.event.body, blob }, chunks: this.chunks };
    delete (event.body as { inline?: string }).inline;
    await atomicWrite(join(this.dir, "event.json"), JSON.stringify(event));
    await mkdir(join(this.store.root, "sha256"), { recursive: true, mode: 0o700 });
    await rename(join(this.dir, "body"), this.store.path(blob));
    await syncDirectory(join(this.store.root, "sha256"));
    await syncDirectory(this.dir);
    return event;
  }
  async release(): Promise<void> {
    if (!this.ended) throw new Error("Spool has not finished");
    await rm(this.dir, { recursive: true });
    await syncDirectory(join(this.store.root, "tmp"));
  }
}
