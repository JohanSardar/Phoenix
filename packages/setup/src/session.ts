import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import type { MomentManifest, RecipeDescriptor, TraceEvent } from "@phoenix/formats";
import { stripSecrets, type SecretPolicy } from "@phoenix/redact";
import { readCapture, writeMomentBundle } from "@phoenix/store";
import { prepareSnapshotMoment } from "./manual.ts";

const eventId = (e: TraceEvent) => e.id ?? `${e.stream}:${e.seq}`;

export interface SessionMomentOptions {
  recipe: { directory: string; descriptor: RecipeDescriptor };
  session: string;
  capture: string;
  at: number;
  id: string;
  check: string;
  out: string;
  policy: SecretPolicy;
  timezone?: string;
}

interface Reading { prompt: string; time: string; model: { provider: string; id: string }; answers: { connector: string }[]; read_only?: Record<string, string[]>; files?: string[] }

async function sideFiles(session: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("/") || pattern.split("/").includes("..")) throw new Error(`Session file pattern must stay beside the session: ${pattern}`);
    if (!pattern.endsWith("/*")) { found.add(pattern); continue; }
    const folder = pattern.slice(0, -2);
    const entries = await readdir(join(dirname(session), folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) found.add(`${folder}/${entry.name}`);
  }
  return [...found].sort();
}

export async function createSessionMoment(o: SessionMomentOptions): Promise<MomentManifest> {
  const resume = o.recipe.descriptor.resume;
  if (!resume) throw new Error(`The ${o.recipe.descriptor.name} recipe cannot resume sessions`);
  const lines: string[] = [];
  for (const line of (await readFile(o.session, "utf8")).split("\n")) {
    const { msg } = await stripSecrets({ body: Buffer.from(line) }, o.policy);
    if (msg.secrets === "unscanned") throw new Error("The session could not be scanned for secrets");
    lines.push(msg.body ? Buffer.from(msg.body).toString("utf8") : line);
  }
  const session = Buffer.from(lines.join("\n"));
  const stripped = new Map<string, Uint8Array>();
  for (const path of await sideFiles(o.session, resume.files ?? [])) {
    const { msg } = await stripSecrets({ body: await readFile(join(dirname(o.session), path)) }, o.policy);
    if (msg.secrets !== "unscanned") stripped.set(path, msg.body!);
  }
  const folder = stripped.size ? await mkdtemp(join(tmpdir(), "phoenix-session-")) : undefined;
  let stdout: string;
  try {
    for (const [path, bytes] of stripped) {
      await mkdir(dirname(join(folder!, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(folder!, path), bytes, { mode: 0o600 });
    }
    const [command, ...args] = resume.moment;
    const child = spawn(command!, [...args, "--at", String(o.at), ...(folder ? ["--files", folder] : [])], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(session);
    const [out, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(resolve => child.once("close", resolve))]);
    if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not read the moment: ${stderr.trim().split("\n").at(-1) ?? code}`);
    stdout = out;
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
  const reading = JSON.parse(stdout) as Reading;
  for (const path of reading.files ?? []) if (!stripped.has(path)) throw new Error(`The ${o.recipe.descriptor.name} recipe named a file it was not given: ${path}`);
  const view = await readCapture(o.capture);
  const events: TraceEvent[] = [];
  const runs = view.runs();
  const task = runs.length === 1 ? runs[0]!.task : "";
  for await (const event of view.events({ capture: view.metadata.capture, task })) events.push(event);
  const atLine = events.filter(e => (e as { source_line?: unknown }).source_line === o.at);
  const mark = atLine.find(e => e.kind === "call") ?? atLine[0];
  if (!mark) throw new Error(`The imported session has no event for line ${o.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, task, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(o.timezone ? { timezone: o.timezone } : {}) });
  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const name of new Set(reading.answers.map(a => a.connector))) connectors[name] = { surface: "mcp", routes: ["transcript"], tier: "recorded", origin: "captured", read_only: (reading.read_only?.[name] ?? []).map(op => ({ op: `tools/call:${op}`, source: "annotation" as const })), data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  const manifest: MomentManifest = {
    ...prepared.manifest, clock: { time: reading.time, timezone: prepared.manifest.clock!.timezone }, model: { id: `${reading.model.provider}/${reading.model.id}` }, connectors,
    resume: { recipe: o.recipe.descriptor.name, session: "data/session.jsonl", moment: "data/session-moment.json", ...(reading.files?.length ? { files: "data/session-files" } : {}) },
  };
  prepared.files.set("data/session.jsonl", session);
  for (const path of reading.files ?? []) prepared.files.set(`data/session-files/${path}`, stripped.get(path)!);
  prepared.files.set("data/session-moment.json", stdout);
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
