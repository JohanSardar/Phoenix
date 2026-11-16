import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { parse } from "yaml";
import { findPlugins, startPlugin } from "@phoenix/plugin-host";
import type { RecipeDescriptor } from "@phoenix/formats";
import { captureConnection } from "./plugin-connection.ts";

const execute = promisify(execFile);
const LIMIT = 512 * 1024 * 1024;

export interface ServiceAnswer { connector: string; op: string; args: unknown; result: unknown; observed_at: string }
export interface Mark {
  phoenix_mark: 1;
  id: string;
  at: string;
  note?: string;
  recipe: string;
  cwd: string;
  session: { path: string; lines: number; sha256: string; copy: string };
  line: number;
  world: { files: "saved" | "not saved"; services: Record<string, string> };
  project?: { tar: string; root: string };
  services?: string;
  read_only?: Record<string, string[]>;
}

export interface MarkOptions {
  home: string;
  recipe: string;
  cwd?: string;
  session?: string;
  at?: number;
  note?: string;
  mcpConfig?: string;
  plugins?: readonly string[];
}

async function run(command: readonly string[], args: readonly string[], cwd: string, input?: Buffer): Promise<string> {
  const child = spawn(command[0]!, [...command.slice(1), ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(input ?? "");
  const [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(done => child.once("close", done))]);
  if (code !== 0) throw new Error(stderr.trim().split("\n").at(-1) || `${command.join(" ")} exited ${code}`);
  return stdout;
}

async function projectTar(cwd: string): Promise<{ root: string; tar: Buffer }> {
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  const root = await execute("git", ["rev-parse", "--show-toplevel"], { cwd }).then(out => out.stdout.trim(), () => undefined);
  if (!root) return { root: cwd, tar: (await execute("tar", ["-cf", "-", "--exclude=./.git", "--exclude=./node_modules", "."], { cwd, env, encoding: "buffer", maxBuffer: LIMIT })).stdout };
  const listed = (await execute("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: LIMIT })).stdout.split("\0").filter(Boolean);
  const files = [...new Set(listed)].filter(path => existsSync(join(root, path)));
  const child = spawn("tar", ["-cf", "-", "--null", "-T", "-"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(files.map(path => path + "\0").join(""));
  const parts: Buffer[] = [];
  child.stdout.on("data", part => parts.push(part));
  const [stderr, code] = await Promise.all([text(child.stderr), new Promise<number | null>(done => child.once("close", done))]);
  if (code !== 0) throw new Error(`Could not copy the project's files: ${stderr.trim()}`);
  return { root, tar: Buffer.concat(parts) };
}

async function serviceReads(o: MarkOptions & { recorded: { connector: string; op: string; args: unknown; result: unknown }[] }, at: string): Promise<{ status: Record<string, string>; answers: ServiceAnswer[]; readOnly: Record<string, string[]> }> {
  const status: Record<string, string> = {}, answers: ServiceAnswer[] = [], readOnly: Record<string, string[]> = {};
  if (!o.mcpConfig || !o.plugins?.length) return { status, answers, readOnly };
  const servers = (JSON.parse(await readFile(o.mcpConfig, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string }> }).mcpServers ?? {};
  for (const plugin of await findPlugins([...o.plugins])) {
    for (const [name, server] of Object.entries(servers)) {
      if (!plugin.descriptor.recognize?.mcp_servers?.includes(name)) continue;
      const scratch = await mkdtemp(join(tmpdir(), "phoenix-mark-"));
      let session: Awaited<ReturnType<typeof startPlugin>> | undefined;
      let connection: Awaited<ReturnType<typeof captureConnection>> | undefined;
      try {
        if (!server.command) throw new Error("its MCP entry has no command");
        const own = o.recorded.filter(answer => answer.connector === name);
        const events = own.flatMap((answer, seq) => [
          { v: 1, capture: "mark", stream: "mark", seq: seq * 2, ts: { wall: at }, kind: "call", connector: plugin.descriptor.connector, surface: "mcp", op: `tools/call:${answer.op}`, body: { inline: JSON.stringify({ jsonrpc: "2.0", id: seq, method: "tools/call", params: { name: answer.op, arguments: answer.args } }) } },
          { v: 1, capture: "mark", stream: "mark", seq: seq * 2 + 1, ts: { wall: at }, kind: "result", connector: plugin.descriptor.connector, surface: "mcp", op: `tools/call:${answer.op}`, body: { inline: JSON.stringify({ jsonrpc: "2.0", id: seq, result: answer.result }) } },
        ]);
        await writeFile(join(scratch, "mark.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""));
        session = await startPlugin(plugin, "capture", { context: { segments: [join(scratch, "mark.jsonl")] } });
        const plan = await session.request("capture", { phase: "plan", connector: plugin.descriptor.connector });
        const calls = plan.status === "answer" ? (plan.value as { calls?: { op: string; args: unknown }[] }).calls : undefined;
        if (!Array.isArray(calls)) throw new Error("its plugin made no plan of reads");
        if (calls.some(call => !plugin.descriptor.read_only?.includes(call.op))) throw new Error("its plugin asked for a read that is not declared read-only");
        if (!calls.length) { status[name] = "nothing to read: the session had not used it yet"; continue; }
        connection = await captureConnection({ surface: "mcp", command: [server.command, ...server.args ?? []], ...(server.cwd ? { cwd: server.cwd } : {}), env: { ...process.env, ...server.env } }, name, 30_000);
        for (const call of calls) {
          const observation = await connection.call(call.op, call.args);
          const reply = JSON.parse(Buffer.from(observation.response.body).toString()) as { result?: unknown; error?: unknown };
          if (reply.result !== undefined) answers.push({ connector: name, op: call.op.slice("tools/call:".length), args: call.args, result: reply.result, observed_at: new Date().toISOString() });
        }
        status[name] = "saved";
        readOnly[name] = (plugin.descriptor.read_only ?? []).filter(op => op.startsWith("tools/call:")).map(op => op.slice("tools/call:".length));
      } catch (error) { status[name] = `not saved: ${error instanceof Error ? error.message : String(error)}`; }
      finally { connection?.close(); await session?.stop(); await rm(scratch, { recursive: true, force: true }); }
    }
  }
  return { status, answers, readOnly };
}

export async function markSession(o: MarkOptions): Promise<{ mark: Mark; directory: string }> {
  const recipe = resolve(o.recipe);
  const descriptor = parse(await readFile(recipe, "utf8")) as RecipeDescriptor;
  if (!descriptor.resume) throw new Error(`The ${descriptor.name} recipe cannot put its harness back in a moment`);
  const recipeDir = dirname(recipe);
  const path = o.session ? resolve(o.session) : descriptor.resume.locate ? (await run(descriptor.resume.locate, ["--cwd", resolve(o.cwd ?? ".")], recipeDir)).trim() : undefined;
  if (!path) throw new Error(`The ${descriptor.name} recipe cannot find its live session; pass --session <file>`);
  const at = new Date().toISOString();
  const bytes = await readFile(path);
  const complete = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  const lines = complete.toString("utf8").split("\n").length - 1;
  if (!lines) throw new Error("The session has no complete line yet");
  if (o.at !== undefined && (!Number.isInteger(o.at) || o.at < 1 || o.at > lines)) throw new Error(`--at must be a line of the session (1-${lines})`);
  const live = o.at === undefined;
  const reading = JSON.parse(await run(descriptor.resume.moment, ["--at", String(o.at ?? lines)], recipeDir, complete)) as { cwd?: string; answers: { connector: string; op: string; args: unknown; result: unknown }[] };
  const cwd = resolve(o.cwd ?? reading.cwd ?? ".");
  const id = `${at.replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomUUID().slice(0, 8)}`;
  const directory = join(o.home, "marks", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "session.jsonl"), complete, { mode: 0o600 });
  const mark: Mark = {
    phoenix_mark: 1, id, at, ...(o.note ? { note: o.note } : {}), recipe, cwd,
    session: { path, lines, sha256: `sha256:${createHash("sha256").update(complete).digest("hex")}`, copy: "session.jsonl" },
    line: o.at ?? lines,
    world: { files: "not saved", services: {} },
  };
  if (live) {
    const project = await projectTar(cwd);
    await writeFile(join(directory, "project.tar"), project.tar, { mode: 0o600 });
    mark.project = { tar: "project.tar", root: project.root };
    mark.world.files = "saved";
    const services = await serviceReads({ ...o, recorded: reading.answers }, at);
    mark.world.services = services.status;
    if (Object.keys(services.readOnly).length) mark.read_only = services.readOnly;
    if (services.answers.length) {
      await writeFile(join(directory, "services.json"), JSON.stringify(services.answers) + "\n", { mode: 0o600 });
      mark.services = "services.json";
    }
  }
  await writeFile(join(directory, "mark.json"), JSON.stringify(mark, null, 2) + "\n", { mode: 0o600 });
  return { mark, directory };
}

export async function readMark(directory: string): Promise<{ mark: Mark; session: string; services: ServiceAnswer[]; project?: { root: string; tar: Buffer } }> {
  const mark = JSON.parse(await readFile(join(directory, "mark.json"), "utf8")) as Mark;
  if (mark.phoenix_mark !== 1) throw new Error(`Not a Phoenix mark: ${directory}`);
  const live: Buffer | undefined = await readFile(mark.session.path).catch(() => undefined);
  let end = 0;
  for (let line = 0; live && line < mark.session.lines && end >= 0; line++) end = live.indexOf(10, end) + 1 || -1;
  const same = !!live && end > 0 && `sha256:${createHash("sha256").update(live.subarray(0, end)).digest("hex")}` === mark.session.sha256;
  return {
    mark,
    session: same ? mark.session.path : join(directory, mark.session.copy),
    services: mark.services ? JSON.parse(await readFile(join(directory, mark.services), "utf8")) as ServiceAnswer[] : [],
    ...(mark.project ? { project: { root: mark.project.root, tar: await readFile(join(directory, mark.project.tar)) } } : {}),
  };
}
