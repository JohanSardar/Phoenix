import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import type { Duplex, Readable, Writable } from "node:stream";
import type { Sandbox, SandboxSpec, SandboxProcess, EngineChannel } from "@phoenix/sandbox";
import type { InstalledPlugin } from "./discovery.ts";

export type PluginReply =
  | { status: "answer"; value: unknown }
  | { status: "unsupported"; reason: string }
  | { status: "invalid-input"; reason: string }
  | { status: "execution-failure"; reason: string };

export interface PluginContext {
  snapshot?: string;
  seed?: string;
  now?: string;
  segments?: string[];
}

export interface PluginSession {
  request(method: "initialize" | "call" | "state" | "capture", params: Record<string, unknown>): Promise<PluginReply>;
  stop(): Promise<void>;
}

export interface PluginStartOptions {
  context: PluginContext;
  env?: Record<string, string>;
  timeoutMs?: number;
  replay?: { sandbox: Sandbox; spec: Omit<SandboxSpec, "argv" | "env"> };
  onStderr?: (chunk: Buffer) => void;
  onConnection?: (connection: { destination: { host: string; port: number }; stream: Duplex }) => void;
}

export class PluginProcessError extends Error {}

function reply(value: unknown): PluginReply {
  if (typeof value !== "object" || value === null) throw new PluginProcessError("Plugin sent a malformed reply");
  const r = value as Record<string, unknown>;
  if (r.status === "answer" && "value" in r) return r as PluginReply;
  if (["unsupported", "invalid-input", "execution-failure"].includes(String(r.status)) && typeof r.reason === "string") return r as PluginReply;
  throw new PluginProcessError("Plugin reply must distinguish answer, unsupported, invalid-input and execution-failure");
}

export async function startPlugin(plugin: InstalledPlugin, mode: "capture" | "serve", options: PluginStartOptions): Promise<PluginSession> {
  const command = plugin.descriptor[mode];
  if (!command) throw new PluginProcessError(`Plugin has no ${mode} command`);
  if (mode === "serve" && !options.replay) throw new PluginProcessError("Replay plugins require a sandbox");
  const timeoutMs = options.timeoutMs ?? 30_000;
  let input: Readable;
  let output: Writable;
  let stderr: Readable;
  let stop: () => Promise<void>;
  let exited: Promise<unknown>;
  let channel: EngineChannel | undefined;
  let process: SandboxProcess | undefined;
  if (options.replay) {
    const started = await options.replay.sandbox.start({ ...options.replay.spec, argv: command.command, env: options.env ?? {} });
    process = started.process;
    channel = started.channel;
    input = process.stdout;
    output = process.stdin;
    stderr = process.stderr;
    stop = () => started.process.stop();
    exited = process.exited;
    void process.interrupted.then(error => fail(error));
  } else {
    const child = spawn(command.command[0]!, command.command.slice(1), {
      cwd: plugin.directory, env: { PATH: globalThis.process.env.PATH, ...options.env }, stdio: "pipe",
    });
    input = child.stdout;
    output = child.stdin;
    stderr = child.stderr;
    exited = new Promise((resolve) => { child.once("error", resolve); child.once("close", resolve); });
    stop = async () => { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 1000); await exited; clearTimeout(timer); };
  }
  const pending = new Map<number, { resolve: (reply: PluginReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; abort?: (error: Error) => void }>();
  let failure: Error | undefined;
  let id = 0;
  let readyResolve!: (url: URL) => void;
  let readyReject!: (error: Error) => void;
  const ready = command.protocol === "http" ? new Promise<URL>((resolve, reject) => { readyResolve = resolve; readyReject = reject; }) : undefined;
  const fail = (error: Error) => {
    failure ??= error;
    readyReject?.(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); item.abort?.(error); }
    pending.clear();
  };
  if (channel) void (async () => {
    try {
      for await (const connection of channel!) {
        if (options.onConnection) options.onConnection(connection);
        else connection.stream.destroy();
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  })();
  let said = "";
  stderr.on("data", (data: Buffer) => { said = (said + data.toString("utf8")).slice(-2000); options.onStderr?.(data); });
  input.on("error", fail);
  output.on("error", fail);
  exited.then(() => fail(new PluginProcessError("Plugin process stopped")));
  const lines = createInterface({ input });
  lines.on("close", () => fail(new PluginProcessError("Plugin protocol stream closed")));
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.phoenix_plugin !== 1) throw new PluginProcessError("Unsupported plugin protocol version");
      if (command.protocol === "http") {
        const url = new URL(message.ready.url);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new PluginProcessError("Plugin HTTP endpoint must be plain HTTP on loopback");
        readyResolve(url);
        return;
      }
      const item = pending.get(message.id);
      if (!item) throw new PluginProcessError("Plugin replied to an unknown request");
      const result = reply(message);
      pending.delete(message.id);
      clearTimeout(item.timer);
      item.resolve(result);
    } catch (error) { fail(error instanceof Error ? error : new PluginProcessError(String(error))); }
  });
  let endpoint: URL | undefined;
  const session: PluginSession = {
    async request(method, params) {
      if (failure) throw failure;
      if (mode === "capture" && method === "call" && !plugin.descriptor.read_only?.includes(String(params.op))) return { status: "invalid-input", reason: "Capture plugins may call only declared read-only operations" };
      const message = { phoenix_plugin: 1, id: ++id, method, params };
      if (command.protocol === "http") {
        return new Promise((resolve, reject) => {
          let timer: NodeJS.Timeout;
          const req = httpRequest(endpoint!, {
            method: "POST", headers: { "content-type": "application/json" },
            ...(channel ? { createConnection: () => channel!.connect(Number(endpoint!.port || 80)) } : {}),
          }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("error", (error) => { pending.delete(message.id); clearTimeout(timer); reject(error); });
            res.on("end", () => {
              pending.delete(message.id);
              clearTimeout(timer);
              try {
                if (res.statusCode !== 200) throw new PluginProcessError(`Plugin HTTP status ${res.statusCode}`);
                const parsed = JSON.parse(body);
                if (parsed.phoenix_plugin !== 1 || parsed.id !== message.id) throw new PluginProcessError("Plugin HTTP reply version or id mismatch");
                resolve(reply(parsed));
              } catch (error) { reject(error); }
            });
          });
          timer = setTimeout(() => req.destroy(new PluginProcessError("Plugin request timed out")), timeoutMs);
          pending.set(message.id, { resolve, reject, timer, abort: (error) => { req.destroy(error); } });
          req.on("error", (error) => { pending.delete(message.id); clearTimeout(timer); reject(error); });
          req.end(JSON.stringify(message));
        });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(message.id); reject(new PluginProcessError("Plugin request timed out")); }, timeoutMs);
        pending.set(message.id, { resolve, reject, timer });
        output.write(JSON.stringify(message) + "\n");
      });
    },
    async stop() { fail(new PluginProcessError("Plugin stopped by host")); lines.close(); await stop(); },
  };
  try {
    if (ready) {
      const timer = setTimeout(() => readyReject(new PluginProcessError("Plugin HTTP readiness timed out")), timeoutMs);
      try { endpoint = await ready; } finally { clearTimeout(timer); }
    }
    const initialized = await session.request("initialize", { ...options.context, read_only: plugin.descriptor.read_only ?? [] });
    if (initialized.status !== "answer") throw new PluginProcessError(`Plugin initialization failed: ${JSON.stringify(initialized)}`);
    return session;
  } catch (error) {
    await session.stop();
    throw error instanceof PluginProcessError && said.trim() ? new PluginProcessError(`${error.message}; the plugin said: ${said.trim()}`) : error;
  }
}
