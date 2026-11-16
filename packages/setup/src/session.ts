import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import type { MomentManifest, RecipeDescriptor, TraceEvent } from "@phoenix/formats";
import { stripSecrets, type SecretPolicy } from "@phoenix/redact";
import { readCapture, writeMomentBundle } from "@phoenix/store";
import { prepareSnapshotMoment } from "./manual.ts";

const eventId = (e: TraceEvent) => e.id ?? `${e.stream}:${e.seq}`;
const execute = promisify(execFile);

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
interface Reading { at: number; prompt: string; time: string; cwd?: string; model: { provider: string; id: string }; answers: SessionAnswer[]; read_only?: Record<string, string[]>; files?: string[]; edits?: { line: number; text: string }[] }
type ProjectCopy = Omit<NonNullable<NonNullable<MomentManifest["resume"]>["project"]>, "tar" | "more"> & { parts: Buffer[] };

const PART_LIMIT = 1536 * 1024 * 1024;

async function projectCopy(cwd: string | undefined, time: string): Promise<ProjectCopy | undefined> {
  if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) return undefined;
  const git = async (args: string[], at = cwd) => (await execute("git", args, { cwd: at, encoding: "utf8" })).stdout.trim();
  const root = await git(["rev-parse", "--show-toplevel"]).catch(() => undefined);
  const commit = root && await git(["rev-list", "-1", `--before=${time}`, "HEAD"], root).catch(() => "");
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-copy-"));
  const files = join(scratch, "files");
  try {
    await mkdir(files);
    const left_out: string[] = [];
    if (root && commit) {
      const listing = (await execute("git", ["ls-tree", "-r", "-z", commit], { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })).stdout.toString("utf8").split("\0").filter(Boolean);
      const blobs = listing.map(line => { const tab = line.indexOf("\t"); const [mode, type, sha] = line.slice(0, tab).split(" ") as [string, string, string]; return { mode, type, sha, path: line.slice(tab + 1) }; }).filter(blob => blob.type === "blob");
      const write = async (blob: typeof blobs[number]): Promise<void> => {
        const bytes = (await execute("git", ["cat-file", "blob", blob.sha], { cwd: root, encoding: "buffer", maxBuffer: 2 ** 31 - 1 })).stdout;
        await mkdir(dirname(join(files, blob.path)), { recursive: true });
        if (blob.mode === "120000") await symlink(bytes.toString("utf8"), join(files, blob.path));
        else await writeFile(join(files, blob.path), bytes, { mode: blob.mode === "100755" ? 0o755 : 0o644 });
      };
      const queue = [...blobs];
      await Promise.all(Array.from({ length: 8 }, async () => { for (let blob = queue.shift(); blob; blob = queue.shift()) await write(blob); }));
    } else {
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(join(cwd, folder), { withFileTypes: true }).catch(() => { left_out.push(folder); return []; })) {
          const path = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { if (entry.name !== ".git" && entry.name !== "node_modules") { await mkdir(join(files, path)); await walk(path); } continue; }
          if (entry.isSymbolicLink()) await symlink(await readlink(join(cwd, path)), join(files, path));
          else if (entry.isFile()) await copyFile(join(cwd, path), join(files, path)).catch(() => left_out.push(path));
        }
      };
      await walk("");
    }
    const groups: string[][] = [[]];
    let size = 0;
    const group = async (folder: string): Promise<void> => {
      for (const entry of await readdir(join(files, folder), { withFileTypes: true })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory() && (await readdir(join(files, path))).length) { await group(path); continue; }
        const bytes = entry.isDirectory() ? 0 : (await lstat(join(files, path))).size;
        if (size + bytes > PART_LIMIT && groups.at(-1)!.length) { groups.push([]); size = 0; }
        groups.at(-1)!.push(path);
        size += bytes;
      }
    };
    await group("");
    const parts: Buffer[] = [];
    for (const [index, paths] of groups.entries()) {
      await writeFile(join(scratch, `list-${index}`), paths.map(path => path + "\0").join(""));
      await execute("tar", ["-cf", join(scratch, `part-${index}.tar`), "-C", files, "--no-recursion", "--null", "-T", join(scratch, `list-${index}`)]);
      parts.push(await readFile(join(scratch, `part-${index}.tar`)));
      await rm(join(scratch, `part-${index}.tar`));
    }
    return root && commit
      ? { root, source: "git", commit, taken_at: new Date(await git(["show", "-s", "--format=%cI", commit], root)).toISOString(), left_out, parts }
      : { root: cwd, source: "today", taken_at: new Date().toISOString(), left_out: left_out.sort(), parts };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

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
  const stripped = new Map<string, Uint8Array>();
  for (const path of await sideFiles(o.session, resume.files ?? [])) {
    const { msg } = await stripSecrets({ body: await readFile(join(dirname(o.session), path)) }, o.policy);
    if (msg.secrets !== "unscanned") stripped.set(path, msg.body!);
  }
  const [command, ...args] = resume.moment;
  const where = o.fromBeginning ? ["--from-beginning"] : ["--at", String(o.at)];
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-session-"));
  let stdout: string, stderr: string, code: number | null;
  try {
    for (const [path, bytes] of stripped) {
      await mkdir(dirname(join(scratch, "files", path)), { recursive: true, mode: 0o700 });
      await writeFile(join(scratch, "files", path), bytes, { mode: 0o600 });
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
    const child = spawn(command!, [...args, ...where, ...changes, ...(stripped.size ? ["--files", join(scratch, "files")] : [])], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
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
  const events: TraceEvent[] = [];
  const runs = view.runs();
  const task = runs.length === 1 ? runs[0]!.task : "";
  for await (const event of view.events({ capture: view.metadata.capture, task })) events.push(event);
  const atLine = events.filter(e => (e as { source_line?: unknown }).source_line === reading.at);
  const mark = atLine.find(e => e.kind === "call") ?? atLine[0];
  if (!mark) throw new Error(`The imported session has no event for line ${reading.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, task, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(o.timezone ? { timezone: o.timezone } : {}) });
  const copy = await projectCopy(reading.cwd, reading.time);
  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const name of new Set(reading.answers.map(a => a.connector))) connectors[name] = { surface: "mcp", routes: ["transcript"], tier: "recorded", origin: reading.answers.every(a => a.connector !== name || a.world) ? "seeded" : "captured", read_only: [...(o.readOnly?.[name] ?? []).map(op => ({ op: `tools/call:${op}`, source: "plugin" as const })), ...(reading.read_only?.[name] ?? []).filter(op => !o.readOnly?.[name]?.includes(op)).map(op => ({ op: `tools/call:${op}`, source: "annotation" as const }))], data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  const manifest: MomentManifest = {
    ...prepared.manifest, clock: { time: reading.time, timezone: prepared.manifest.clock!.timezone }, model: { id: `${reading.model.provider}/${reading.model.id}` }, connectors,
    resume: {
      recipe: o.recipe.descriptor.name, session: "data/session.jsonl", moment: "data/session-moment.json",
      ...(reading.files?.length ? { files: "data/session-files" } : {}),
      ...(copy ? { project: { tar: "data/project.tar", ...(copy.parts.length > 1 ? { more: copy.parts.slice(1).map((_, index) => `data/project.${index + 1}.tar`) } : {}), root: copy.root, source: copy.source, ...(copy.commit ? { commit: copy.commit } : {}), taken_at: copy.taken_at, left_out: copy.left_out } } : {}),
      ...(o.fromBeginning ? { from_beginning: true } : {}),
      ...(reading.edits?.length ? { changed_answers: reading.edits.map(edit => edit.line) } : {}),
      ...(o.madeUp ? { made_up: true } : {}),
      ...(o.marked ? { marked: o.marked } : {}),
    },
  };
  for (const [index, part] of copy?.parts.entries() ?? []) prepared.files.set(index ? `data/project.${index}.tar` : "data/project.tar", part);
  prepared.files.set("data/session.jsonl", session);
  for (const path of reading.files ?? []) prepared.files.set(`data/session-files/${path}`, stripped.get(path)!);
  prepared.files.set("data/session-moment.json", JSON.stringify(reading) + "\n");
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
