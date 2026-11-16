import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

interface Reading { prompt: string; time: string; model: { provider: string; id: string }; answers: { connector: string }[]; read_only?: Record<string, string[]> }

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
  const [command, ...args] = resume.moment;
  const child = spawn(command!, [...args, "--at", String(o.at)], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(session);
  const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(resolve => child.once("close", resolve))]);
  if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not read the moment: ${stderr.trim().split("\n").at(-1) ?? code}`);
  const reading = JSON.parse(stdout) as Reading;
  const view = await readCapture(o.capture);
  const events: TraceEvent[] = [];
  for await (const event of view.events({ capture: view.metadata.capture, task: "" })) events.push(event);
  const atLine = events.filter(e => (e as { source_line?: unknown }).source_line === o.at);
  const mark = atLine.find(e => e.kind === "call") ?? atLine[0];
  if (!mark) throw new Error(`The imported session has no event for line ${o.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(o.timezone ? { timezone: o.timezone } : {}) });
  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const name of new Set(reading.answers.map(a => a.connector))) connectors[name] = { surface: "mcp", routes: ["transcript"], tier: "recorded", origin: "captured", read_only: (reading.read_only?.[name] ?? []).map(op => ({ op: `tools/call:${op}`, source: "annotation" as const })), data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  const manifest: MomentManifest = {
    ...prepared.manifest, clock: { time: reading.time, timezone: prepared.manifest.clock!.timezone }, model: { id: `${reading.model.provider}/${reading.model.id}` }, connectors,
    resume: { recipe: o.recipe.descriptor.name, session: "data/session.jsonl", moment: "data/session-moment.json" },
  };
  prepared.files.set("data/session.jsonl", session);
  prepared.files.set("data/session-moment.json", stdout);
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
