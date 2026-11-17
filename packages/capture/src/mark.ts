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
import type { PluginDescriptor, RecipeDescriptor } from "@phoenix/formats";
import { captureConnection } from "./plugin-connection.ts";
import { sanitizeMessage, secretPolicy } from "./secrets.ts";

const execute = promisify(execFile);
const LIMIT = 512 * 1024 * 1024;
const COMMAND_ROUNDS = 3, COMMAND_READS = 60, COMMAND_BYTES = 8 * 1024 * 1024;

export interface ServiceAnswer { connector: string; op: string; args: unknown; result: unknown; observed_at: string }
/** A read-only command-line read made at the mark: the invocation and its frames, secret-stripped, as a prefetch event's body holds them. */
export interface CommandRead { connector: string; op: string; args: { argv: string[]; stdin?: string }; request: { body: string }; response: { body: string }; observed_at: string }
/** The plugin commands in one shell line, as the engine's recognizer reads them. */
export type RecognizeCommands = (line: string, plugins: readonly PluginDescriptor[]) => { connector: string; argv: string[]; stdin?: string }[] | undefined;
interface ShellTool { command: string; cwd?: string; output?: string }
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
  commands?: string;
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
  recognize?: RecognizeCommands;
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
        const plan = await session.request("capture", { phase: "plan", connector: plugin.descriptor.connector, surface: "mcp" });
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

const pointer = (value: unknown, path: string): unknown => path.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
  .reduce<unknown>((at, key) => at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, value);

/**
 * Read-only command-line reads of what the session touched, for each plugin that recognizes commands. Its capture
 * command plans them from the session's own command lines; a later plan sees the reads made so far. The host checks
 * each read against the plugin's read_only rule, runs it with the person's own login, and strips secrets from what it
 * printed. Planning stops when a plan asks for nothing new, after COMMAND_ROUNDS plans, or at the size cap.
 */
async function commandReads(o: MarkOptions & { recorded: { connector: string; op: string; args: unknown; result: unknown; observed_at?: string }[]; shell?: Record<string, Record<string, ShellTool>> }, cwd: string): Promise<{ status: Record<string, string>; reads: CommandRead[] }> {
  const status: Record<string, string> = {}, reads: CommandRead[] = [];
  if (!o.recognize || !o.plugins?.length) return { status, reads };
  const policy = await secretPolicy(o.home);
  for (const plugin of await findPlugins([...o.plugins])) {
    const commands = plugin.descriptor.recognize?.commands ?? [];
    if (!commands.length || !plugin.descriptor.capture) continue;
    const events: object[] = [];
    for (const [index, answer] of o.recorded.entries()) {
      const tool = o.shell?.[answer.connector]?.[answer.op];
      const line = tool ? (answer.args as Record<string, unknown> | null)?.[tool.command] : undefined;
      if (!tool || typeof line !== "string") continue;
      const result = answer.result as { content?: { type?: string; text?: string }[] } | undefined;
      const found = tool.output ? pointer(result, tool.output) : undefined;
      const output = typeof found === "string" ? found : result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("") ?? "";
      for (const [at, call] of (o.recognize(line, [plugin.descriptor]) ?? []).entries()) {
        if (call.connector !== plugin.descriptor.connector) continue;
        const event = (seq: number, kind: string, op: string, inline: string) => ({ v: 1, capture: "mark", stream: `session-${index}-${at}`, seq, ts: { wall: answer.observed_at }, kind, connector: plugin.descriptor.connector, surface: "cli", op, body: { inline } });
        events.push(event(0, "call", call.argv[0]!, JSON.stringify({ argv: call.argv, cwd, env: {}, terminals: { stdin: null, stdout: null, stderr: null } })));
        if (call.stdin !== undefined) events.push(event(1, "call", "frame:out:0", call.stdin));
        events.push(event(2, "result", "frame:back:1", output));
      }
    }
    if (!events.length) continue;
    const name = `${commands.join(", ")} command`;
    const scratch = await mkdtemp(join(tmpdir(), "phoenix-mark-"));
    let session: Awaited<ReturnType<typeof startPlugin>> | undefined;
    const made = new Map<string, CommandRead>();
    let bytes = 0, capped = false;
    try {
      await writeFile(join(scratch, "mark.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""));
      session = await startPlugin(plugin, "capture", { context: { segments: [join(scratch, "mark.jsonl")] } });
      const readOnly = (op: string, argv: readonly string[]) => commands.includes(op) && argv[0] === op && (plugin.descriptor.read_only ?? []).some(entry => entry.split(" ").every((word, i) => argv[i] === word));
      for (let round = 0; round < COMMAND_ROUNDS && !capped; round++) {
        const results = [...made.values()].map(read => ({ op: read.op, args: read.args, observation: { request: read.request, response: read.response } }));
        const plan = await session.request("capture", { phase: "plan", connector: plugin.descriptor.connector, surface: "cli", results });
        const calls = plan.status === "answer" ? (plan.value as { calls?: { op: string; args: { argv?: unknown; stdin?: unknown } }[] }).calls : undefined;
        if (!Array.isArray(calls)) throw new Error("its plugin made no plan of reads");
        if (calls.some(call => typeof call?.op !== "string" || !Array.isArray(call.args?.argv) || !call.args.argv.every(arg => typeof arg === "string") || (call.args.stdin !== undefined && typeof call.args.stdin !== "string") || !readOnly(call.op, call.args.argv as string[])))
          throw new Error("its plugin asked for a read that is not declared read-only");
        const fresh = calls.filter(call => !made.has(JSON.stringify([call.op, call.args])));
        if (!fresh.length) break;
        for (const call of fresh) {
          if (made.size >= COMMAND_READS) { capped = true; break; }
          const own = plugin.descriptor.capture.reads?.[call.op];
          const target = own
            ? { surface: "cli" as const, command: own, cwd: plugin.directory, env: { ...process.env, PHOENIX_COMMAND_CWD: cwd } }
            : { surface: "cli" as const, command: [call.op], cwd, env: process.env };
          const connection = await captureConnection(target, plugin.descriptor.connector, 30_000);
          const observation = await connection.call(call.op, call.args).finally(() => connection.close());
          const frames = JSON.parse(Buffer.from(observation.response.body).toString()) as { dir: string; stream: number; bytes: string; last: boolean }[];
          for (const frame of frames) {
            const clean = await sanitizeMessage({ body: Buffer.from(frame.bytes, "base64") }, policy);
            if (clean.unscanned.length) throw new Error("a read's output could not be scanned for secrets");
            frame.bytes = Buffer.from(clean.msg.body ?? new Uint8Array()).toString("base64");
          }
          const size = frames.filter(frame => frame.dir === "back").reduce((sum, frame) => sum + Buffer.from(frame.bytes, "base64").length, 0);
          if (bytes + size > COMMAND_BYTES) { capped = true; break; }
          bytes += size;
          const record = await sanitizeMessage({ body: Buffer.from(JSON.stringify({ connector: plugin.descriptor.connector, op: call.op, args: call.args, request: { body: Buffer.from(observation.request.body).toString() }, response: { body: JSON.stringify(frames) }, observed_at: new Date().toISOString() })) }, policy);
          if (record.unscanned.length) throw new Error("a read could not be scanned for secrets");
          made.set(JSON.stringify([call.op, call.args]), JSON.parse(Buffer.from(record.msg.body!).toString()) as CommandRead);
        }
      }
      reads.push(...made.values());
      status[name] = !made.size ? "nothing to read: the session's command lines named nothing to read back" : capped ? `saved ${made.size} reads, then stopped at the size cap (${COMMAND_READS} reads, ${COMMAND_BYTES / 1024 / 1024} MB of output)` : `saved ${made.size} reads`;
    } catch (error) { status[name] = `not saved: ${error instanceof Error ? error.message : String(error)}`; }
    finally { await session?.stop(); await rm(scratch, { recursive: true, force: true }); }
  }
  return { status, reads };
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
  const reading = JSON.parse(await run(descriptor.resume.moment, ["--at", String(o.at ?? lines)], recipeDir, complete)) as { cwd?: string; answers: { connector: string; op: string; args: unknown; result: unknown; observed_at?: string }[]; shell?: Record<string, Record<string, ShellTool>> };
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
    const commands = await commandReads({ ...o, recorded: reading.answers, ...(reading.shell ? { shell: reading.shell } : {}) }, cwd);
    mark.world.services = { ...services.status, ...commands.status };
    if (Object.keys(services.readOnly).length) mark.read_only = services.readOnly;
    if (services.answers.length) {
      await writeFile(join(directory, "services.json"), JSON.stringify(services.answers) + "\n", { mode: 0o600 });
      mark.services = "services.json";
    }
    if (commands.reads.length) {
      await writeFile(join(directory, "commands.json"), JSON.stringify(commands.reads) + "\n", { mode: 0o600 });
      mark.commands = "commands.json";
    }
  }
  await writeFile(join(directory, "mark.json"), JSON.stringify(mark, null, 2) + "\n", { mode: 0o600 });
  return { mark, directory };
}

export async function readMark(directory: string): Promise<{ mark: Mark; session: string; services: ServiceAnswer[]; commands: CommandRead[]; project?: { root: string; tar: Buffer } }> {
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
    commands: mark.commands ? JSON.parse(await readFile(join(directory, mark.commands), "utf8")) as CommandRead[] : [],
    ...(mark.project ? { project: { root: mark.project.root, tar: await readFile(join(directory, mark.project.tar)) } } : {}),
  };
}
