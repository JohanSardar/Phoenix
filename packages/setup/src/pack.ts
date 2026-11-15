import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import type { MomentManifest, TraceEvent, WorkdirSnapshot } from "@phoenix/formats";
import { openRedactionDetector, scrubPersonalData, type Detection, type PersonalDataDetector } from "@phoenix/redact";
import { digest, readMomentBundle, writeMomentBundle } from "@phoenix/store";
import { object } from "@phoenix/wire";
import { eventId } from "./evidence.ts";

type Withheld = NonNullable<NonNullable<MomentManifest["packed"]>["withheld"]>[number];

export function presidioDetector(url: string): PersonalDataDetector {
  return { async detect(text) {
    const response = await fetch(new URL("analyze", url.endsWith("/") ? url : url + "/"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, language: "en" }), redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Presidio analyzer failed (HTTP ${response.status})`); }
    return (await response.json() as { start: number; end: number; entity_type: string }[]).map((d) => ({ start: d.start, end: d.end, type: d.entity_type }));
  } };
}

export function combinedDetector(detectors: readonly PersonalDataDetector[]): PersonalDataDetector {
  return { async detect(text) {
    const found: Detection[] = [];
    for (const detector of detectors) found.push(...await detector.detect(text));
    return found;
  } };
}

export interface PackResult { manifest: MomentManifest; checkBefore: string; checkAfter: string; scrubbed: string[]; withheld: Withheld[] }

export async function packMoment(root: string, out: string, o: { detector?: PersonalDataDetector } = {}): Promise<PackResult> {
  const bundle = await readMomentBundle(root);
  const policy = { hmacKey: randomBytes(32), detector: o.detector ?? openRedactionDetector() };
  const scrubbed: string[] = [], withheld: Withheld[] = [];
  const files = new Map<string, Uint8Array | string>();
  const file = (path: string) => {
    const bytes = bundle.files.get(path);
    if (!bytes) throw new Error(`Missing bundle file: ${path}`);
    return bytes;
  };
  const scrub = async (bytes: Uint8Array, at: string, extra: { contentType?: string; contentEncoding?: string; secrets?: TraceEvent["secrets"] } = {}) => {
    const result = await scrubPersonalData({ body: bytes, ...extra }, policy);
    if (result.withheld) { withheld.push({ at, ...result.withheld }); return undefined; }
    if (result.changes.length) scrubbed.push(at);
    return { bytes: result.msg.body ?? bytes, ...(result.originalEncoding ? { encoding: result.originalEncoding } : {}) };
  };
  const blob = async (hash: string, at: string, extra: Parameters<typeof scrub>[2] = {}) => {
    const result = await scrub(file(`data/blobs/${hash.slice(7)}`), at, extra);
    if (!result) return undefined;
    const next = digest(result.bytes);
    files.set(`data/blobs/${next.slice(7)}`, result.bytes);
    return { hash: next, ...(result.encoding ? { encoding: result.encoding } : {}) };
  };
  const scrubJson = async (value: unknown, at: string) => {
    const result = await scrub(Buffer.from(JSON.stringify(value)), at, { contentType: "application/json" });
    return result ? JSON.parse(Buffer.from(result.bytes).toString()) : value;
  };
  const references = new Set<string>();

  const events = Buffer.from(file("data/run.jsonl")).toString().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceEvent);
  const heads = new Map<string, readonly string[]>();
  for (const e of events) if (e.surface === "http" && e.kind === "meta" && e.op?.startsWith("frame:back:") && e.body && !heads.has(e.stream)) {
    const raw = "inline" in e.body ? Buffer.from(e.body.inline) : file(`data/blobs/${e.body.blob.slice(7)}`);
    try { const headers = object(JSON.parse(Buffer.from(raw).toString())).headers; if (Array.isArray(headers)) heads.set(e.stream, headers as string[]); } catch {}
  }
  const header = (stream: string, name: string) => { const h = heads.get(stream) ?? []; return h.find((_, i) => i % 2 === 1 && h[i - 1]!.toLowerCase() === name); };
  const packedEvents: TraceEvent[] = [];
  for (const e of events) {
    if (!e.body) { packedEvents.push(e); continue; }
    const at = `data/run.jsonl#${eventId(e)}`;
    const http = e.surface === "http" && e.kind === "result" && !e.body.content_encoding;
    const extra = { ...(e.secrets === "unscanned" ? { secrets: "unscanned" as const } : {}), ...(http && header(e.stream, "content-encoding") ? { contentEncoding: header(e.stream, "content-encoding")! } : {}) };
    const { body, ...rest } = e;
    if ("inline" in body) {
      const result = await scrub(Buffer.from(body.inline), at, extra);
      packedEvents.push(result ? { ...rest, body: { ...body, inline: Buffer.from(result.bytes).toString(), ...(result.encoding ? { content_encoding: result.encoding } : {}) } } : rest);
    } else {
      const result = await blob(body.blob, at, extra);
      packedEvents.push(result ? { ...rest, body: { ...body, blob: result.hash, ...(result.encoding ? { content_encoding: result.encoding } : {}) } } : rest);
    }
  }
  files.set("data/run.jsonl", packedEvents.map((e) => JSON.stringify(e) + "\n").join(""));
  references.add("data/run.jsonl");

  if (bundle.manifest.workdir) {
    const snapshot = JSON.parse(Buffer.from(file(bundle.manifest.workdir)).toString()) as WorkdirSnapshot;
    const entries: WorkdirSnapshot["entries"] = [], unread = [...snapshot.unread];
    for (const entry of snapshot.entries) {
      if (!entry.blob) { entries.push(entry); continue; }
      const at = `${bundle.manifest.workdir}#${entry.path}`;
      const result = await blob(entry.blob, at, (entry as { secrets?: unknown }).secrets === "unscanned" ? { secrets: "unscanned" } : {});
      if (result) entries.push({ ...entry, blob: result.hash });
      else unread.push(entry.path);
    }
    files.set(bundle.manifest.workdir, JSON.stringify({ ...snapshot, entries, unread }, null, 2) + "\n");
    references.add(bundle.manifest.workdir);
  }

  for (const [path, bytes] of bundle.files) {
    if (references.has(path) || path.startsWith("data/blobs/") || !(path.startsWith("data/") || path.startsWith("checks/"))) continue;
    const result = await scrub(bytes, path, path.endsWith(".json") ? { contentType: "application/json" } : {});
    if (result) files.set(path, result.bytes);
  }

  const checkBefore = Buffer.from(file("check.yaml")).toString();
  const checkAfter = stringify(await scrubJson(parse(checkBefore), "check.yaml"));
  files.set("check.draft.yaml", checkAfter);

  const connectors = Object.fromEntries(await Promise.all(Object.entries(bundle.manifest.connectors ?? {}).map(async ([name, c]) =>
    [name, c.tools ? { ...c, tools: await scrubJson(c.tools, `moment.yaml#/connectors/${name}/tools`) } : c] as const)));
  const manifest: MomentManifest = {
    ...bundle.manifest,
    ...(bundle.manifest.prompt !== undefined ? { prompt: await scrubJson(bundle.manifest.prompt, "moment.yaml#/prompt") } : {}),
    ...(bundle.manifest.connectors ? { connectors } : {}),
    packed: { from: bundle.lockHash, scrubbed, withheld },
  };
  await writeMomentBundle(out, { manifest, files });
  return { manifest, checkBefore, checkAfter, scrubbed, withheld };
}

export async function archiveMoment(root: string, archive: string): Promise<string[]> {
  const bundle = await readMomentBundle(root);
  const paths = [...bundle.files.keys()];
  await promisify(execFile)("tar", ["--format=ustar", "-cf", archive, "-C", root, "--", ...paths], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return paths;
}
