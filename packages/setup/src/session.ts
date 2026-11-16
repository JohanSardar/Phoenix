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
  at?: number;
  fromBeginning?: boolean;
  changes?: readonly { line: number; file: string }[];
  answers?: readonly SessionAnswer[];
  readOnly?: Readonly<Record<string, readonly string[]>>;
  marked?: NonNullable<MomentManifest["resume"]>["marked"];
  madeUp?: boolean;
  id: string;
  check: string;
  out: string;
  policy: SecretPolicy;
  timezone?: string;
}

export interface SessionAnswer { id: string; connector: string; op: string; args: unknown; result: unknown; observed_at: string; before_cut: boolean; world?: "exact" | "any-args" }
interface Reading { at: number; prompt: string; time: string; model: { provider: string; id: string }; answers: SessionAnswer[]; read_only?: Record<string, string[]>; edits?: { line: number; text: string }[]; files?: string[] }

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
  if (o.fromBeginning === (o.at !== undefined)) throw new Error("Give the moment a line with --at, or start it --from-beginning");
  const [command, ...args] = resume.moment;
  const where = o.fromBeginning ? ["--from-beginning"] : ["--at", String(o.at)];
  const stripped = new Map<string, Uint8Array>();
  for (const path of await sideFiles(o.session, resume.files ?? [])) {
    const { msg } = await stripSecrets({ body: await readFile(join(dirname(o.session), path)) }, o.policy);
    if (msg.secrets !== "unscanned") stripped.set(path, msg.body!);
  }
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-changed-answers-"));
  const folder = join(scratch, "session-files");
  let stdout: string, stderr: string, code: number | null;
  try {
    for (const [path, bytes] of stripped) {
      await mkdir(dirname(join(folder, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(folder, path), bytes, { mode: 0o600 });
    }
    const changes: string[] = [];
    for (const [index, change] of (o.changes ?? []).entries()) {
      const original = await readFile(change.file);
      const { msg } = await stripSecrets({ body: original }, o.policy);
      if (msg.secrets === "unscanned") throw new Error(`The answer in ${change.file} could not be scanned for secrets`);
      const file = join(scratch, String(index));
      await writeFile(file, msg.body ? Buffer.from(msg.body) : original, { mode: 0o600 });
      changes.push("--change", `${change.line}=${file}`);
    }
    const child = spawn(command!, [...args, ...where, ...changes, ...(stripped.size ? ["--files", folder] : [])], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(Buffer.from(lines.join("\n")));
    [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(done => child.once("close", done))]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not read the moment: ${stderr.trim().split("\n").at(-1) ?? code}`);
  const reading = JSON.parse(stdout) as Reading;
  for (const path of reading.files ?? []) if (!stripped.has(path)) throw new Error(`The ${o.recipe.descriptor.name} recipe named a file it was not given: ${path}`);
  for (const edit of reading.edits ?? []) lines[edit.line - 1] = edit.text;
  reading.answers.push(...o.answers ?? []);
  const session = Buffer.from(lines.join("\n"));
  const view = await readCapture(o.capture);
  let mark: TraceEvent | undefined, task = "";
  for (const run of view.runs()) {
    const atLine: TraceEvent[] = [];
    for await (const event of view.events(run)) if ((event as { source_line?: unknown }).source_line === reading.at) atLine.push(event);
    mark = atLine.find(e => e.kind === "call") ?? atLine[0];
    if (mark) { task = run.task; break; }
  }
  if (!mark) throw new Error(`The imported session has no event for line ${reading.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(task ? { task } : {}), ...(o.timezone ? { timezone: o.timezone } : {}) });
  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const name of new Set(reading.answers.map(a => a.connector))) connectors[name] = { surface: "mcp", routes: ["transcript"], tier: "recorded", origin: reading.answers.every(a => a.connector !== name || a.world) ? "seeded" : "captured", read_only: [...(o.readOnly?.[name] ?? []).map(op => ({ op: `tools/call:${op}`, source: "plugin" as const })), ...(reading.read_only?.[name] ?? []).filter(op => !o.readOnly?.[name]?.includes(op)).map(op => ({ op: `tools/call:${op}`, source: "annotation" as const }))], data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  const manifest: MomentManifest = {
    ...prepared.manifest, clock: { time: reading.time, timezone: prepared.manifest.clock!.timezone }, model: { id: `${reading.model.provider}/${reading.model.id}` }, connectors,
    resume: {
      recipe: o.recipe.descriptor.name, session: "data/session.jsonl", moment: "data/session-moment.json",
      ...(o.fromBeginning ? { from_beginning: true } : {}),
      ...(reading.edits?.length ? { changed_answers: reading.edits.map(edit => edit.line) } : {}),
      ...(o.madeUp ? { made_up: true } : {}),
      ...(o.marked ? { marked: o.marked } : {}),
      ...(reading.files?.length ? { files: "data/session-files" } : {}),
    },
  };
  prepared.files.set("data/session.jsonl", session);
  for (const path of reading.files ?? []) prepared.files.set(`data/session-files/${path}`, stripped.get(path)!);
  prepared.files.set("data/session-moment.json", JSON.stringify(reading) + "\n");
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
