import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
interface Reading { at: number; prompt: string; time: string; model: { provider: string; id: string }; answers: SessionAnswer[]; read_only?: Record<string, string[]>; edits?: { line: number; text: string }[] }

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
  const changes = (o.changes ?? []).flatMap(change => ["--change", `${change.line}=${resolve(change.file)}`]);
  const child = spawn(command!, [...args, ...where, ...changes], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(Buffer.from(lines.join("\n")));
  const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(resolve => child.once("close", resolve))]);
  if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not read the moment: ${stderr.trim().split("\n").at(-1) ?? code}`);
  const reading = JSON.parse(stdout) as Reading;
  for (const edit of reading.edits ?? []) lines[edit.line - 1] = edit.text;
  reading.answers.push(...o.answers ?? []);
  const session = Buffer.from(lines.join("\n"));
  const view = await readCapture(o.capture);
  const events: TraceEvent[] = [];
  for await (const event of view.events({ capture: view.metadata.capture, task: "" })) events.push(event);
  const atLine = events.filter(e => (e as { source_line?: unknown }).source_line === reading.at);
  const mark = atLine.find(e => e.kind === "call") ?? atLine[0];
  if (!mark) throw new Error(`The imported session has no event for line ${reading.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(o.timezone ? { timezone: o.timezone } : {}) });
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
    },
  };
  prepared.files.set("data/session.jsonl", session);
  prepared.files.set("data/session-moment.json", JSON.stringify(reading) + "\n");
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
