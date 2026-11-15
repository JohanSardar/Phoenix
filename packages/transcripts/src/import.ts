import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { checkVersion, validate, type TraceEvent } from "@phoenix/formats";
import { stripSecrets, type SecretPolicy } from "@phoenix/redact";
import { appendCoverage, BlobStore, digest, writeImport } from "@phoenix/store";

export interface ReaderCoverage {
  harness_versions: string[];
  carries: string[];
  lacks: string[];
}
export interface ImportIssue { line?: number; reason: string }
export interface ImportResult {
  reader: string;
  digest: string;
  segment: string;
  added: boolean;
  events: number;
  complete: boolean;
  issues: ImportIssue[];
}
export interface ImportOptions {
  root: string;
  reader: string;
  sourceDigest: string;
  input: Readable;
  policy: SecretPolicy;
  route?: "import" | "transcript";
  finish?: () => Promise<string | undefined>;
}

export function readerCoverage(value: unknown): value is ReaderCoverage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["harness_versions", "carries", "lacks"].every(key => Array.isArray(v[key]) && v[key].every(item => typeof item === "string"))
    && (v.harness_versions as string[]).length > 0;
}

async function* traceLines(input: Readable): AsyncIterable<string | undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (bytes: Uint8Array) => {
    try { return decoder.decode(bytes); } catch { return undefined; }
  };
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      yield decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
  }
  if (pending.length) yield decode(pending);
}

async function cleanEvent(event: TraceEvent, policy: SecretPolicy): Promise<TraceEvent> {
  const { body, ...rest } = event;
  if (body) (rest as TraceEvent).body = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "inline")) as TraceEvent["body"];
  const envelope = await stripSecrets({ body: Buffer.from(JSON.stringify(rest)) }, policy);
  const clean = JSON.parse(Buffer.from(envelope.msg.body!).toString()) as TraceEvent;
  const changes = [...(Array.isArray(clean.secrets) ? clean.secrets : []), ...envelope.changes];
  let unscanned = event.secrets === "unscanned" || envelope.unscanned.length > 0;
  if (body && "inline" in body) {
    const result = await stripSecrets({ body: Buffer.from(body.inline) }, policy);
    clean.body = { ...clean.body, inline: Buffer.from(result.msg.body!).toString() };
    changes.push(...result.changes);
    unscanned ||= result.unscanned.length > 0;
    if (result.changes.length) delete clean.chunks;
  }
  clean.secrets = unscanned ? "unscanned" : changes;
  return clean;
}

export async function importEvents(options: ImportOptions): Promise<ImportResult> {
  const { root, reader, sourceDigest, input, policy } = options;
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(reader) || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest))
    throw new Error("Invalid import identity");
  const metadata = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as { capture: string };
  if (typeof metadata.capture !== "string") throw new Error("Invalid capture metadata");
  const events: TraceEvent[] = [], issues: ImportIssue[] = [];
  const sequences = new Map<string, number>();
  const blobs = new BlobStore(root);
  let line = 0, coverage: ReaderCoverage | undefined;
  try {
    for await (const text of traceLines(input)) {
      line++;
      if (text === undefined) { issues.push({ line, reason: "invalid-utf8" }); continue; }
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch { issues.push({ line, reason: "invalid-json" }); continue; }
      const version = checkVersion("trace", raw);
      if (!version.ok) { issues.push({ line, reason: version.error }); continue; }
      const checked = validate("trace", raw);
      if (!checked.ok) { issues.push({ line, reason: "invalid-trace" }); continue; }
      const event = checked.value;
      if (!Array.isArray(event.verbatim) || event.body && "blob" in event.body) {
        issues.push({ line, reason: "reader-must-declare-verbatim-and-use-inline-bodies" }); continue;
      }
      if (event.seq <= (sequences.get(event.stream) ?? -1)) {
        issues.push({ line, reason: "non-increasing-sequence" }); continue;
      }
      const clean = await cleanEvent(event, policy);
      clean.capture = metadata.capture;
      clean.stream = `${digest(Buffer.from(reader)).slice(7, 23)}.${sourceDigest.slice(7)}.${clean.stream}`;
      clean.route = options.route ?? "import";
      clean.ts = { ...clean.ts };
      delete clean.ts.mono;
      clean.verbatim = clean.verbatim!.filter(field => !["capture", "stream", "route", "ts.mono"].includes(field));
      if (clean.kind === "meta" && clean.op === "transcript.coverage") {
        let value: unknown;
        try { value = JSON.parse(clean.body && "inline" in clean.body ? clean.body.inline : "null"); } catch {}
        if (!readerCoverage(value)) { issues.push({ line, reason: "invalid-coverage" }); continue; }
        coverage = value;
      }
      if (clean.kind === "meta" && clean.op === "transcript.unread") issues.push({ line, reason: "reader-reported-unread" });
      if (!validate("trace", clean).ok) { issues.push({ line, reason: "invalid-redacted-trace" }); continue; }
      if (clean.body && "inline" in clean.body && Buffer.byteLength(clean.body.inline) > 64 * 1024) {
        const { inline, ...fields } = clean.body;
        clean.body = { ...fields, blob: await blobs.put(Buffer.from(inline)) };
      }
      sequences.set(event.stream, event.seq);
      events.push(clean);
    }
  } catch { issues.push({ line: line + 1, reason: "input-failed" }); }
  let failure: string | undefined;
  try { failure = await options.finish?.(); } catch { failure = "reader-failed"; }
  if (failure) issues.push({ reason: failure });
  if (!coverage) issues.push({ reason: "missing-coverage" });
  const complete = issues.length === 0;
  const segment = `import/${reader}.${sourceDigest.slice(7)}.jsonl`;
  const status = { reader, source_digest: sourceDigest, segment, route: options.route ?? "import", coverage, events: events.length, complete, issues };
  const summary: TraceEvent = {
    v: 1, capture: metadata.capture, stream: `import-status.${digest(Buffer.from(reader)).slice(7, 23)}.${sourceDigest.slice(7)}`, seq: 0,
    ts: { wall: events.at(-1)?.ts.wall ?? new Date().toISOString() }, kind: "meta", op: "transcript.status",
    route: options.route ?? "import", verbatim: [], body: { inline: JSON.stringify(status) },
  };
  const added = await writeImport(root, reader, sourceDigest, [...events, summary]);
  if (!added) {
    const text = await readFile(join(root, segment), "utf8");
    const last = JSON.parse(text.trimEnd().split("\n").at(-1)!) as TraceEvent;
    if (last.op !== "transcript.status" || !last.body || !("inline" in last.body)) throw new Error("Missing import status");
    const prior = JSON.parse(last.body.inline) as typeof status;
    return { reader, digest: sourceDigest, segment, added, events: prior.events, complete: prior.complete, issues: prior.issues };
  }
  await appendCoverage(root, status);
  return { reader, digest: sourceDigest, segment, added, events: events.length, complete, issues };
}
