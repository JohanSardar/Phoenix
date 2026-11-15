import { spawn } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough, type Writable } from "node:stream";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { frame, writeBytes, type Backend, type Frame } from "@phoenix/taps";

export function processBackend(command: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Backend {
  return { open(connection) {
    const cli = connection.surface === "cli";
    const invocation = connection.meta as { terminals?: Record<string, { columns: number; rows: number } | null> };
    const terminals = cli ? invocation.terminals : undefined;
    const pty = terminals && Object.values(terminals).some(Boolean);
    const child = spawn(pty ? "python3" : command[0]!, pty ? [fileURLToPath(new URL("./terminal.py", import.meta.url)), JSON.stringify(terminals), ...command] : command.slice(1), {
      cwd: options.cwd, env: options.env ?? process.env, stdio: pty ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    const output = new PassThrough({ objectMode: true, highWaterMark: 16 });
    const forwardSignal = () => { child.kill("SIGTERM"); };
    if (!cli) process.on("SIGTERM", forwardSignal);
    let line = 0;
    const send = (f: Frame) => { if (!output.write(f)) { child.stdout!.pause(); child.stderr!.pause(); } };
    output.on("drain", () => { child.stdout!.resume(); child.stderr!.resume(); });
    child.stdout!.on("data", (bytes: Buffer) => {
      if (cli) send(frame("back", 1, bytes, false));
      else {
        let start = 0;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { send(frame("back", line++, bytes.subarray(start, i + 1), true)); start = i + 1; }
        if (start < bytes.length) send(frame("back", line, bytes.subarray(start), false));
      }
    });
    child.stderr!.on("data", (bytes: Buffer) => send(frame("back", cli ? 2 : -1, bytes, false)));
    child.stdout!.on("end", () => send(frame("back", cli ? 1 : line, new Uint8Array(), true)));
    child.stderr!.on("end", () => send(frame("back", cli ? 2 : -1, new Uint8Array(), true)));
    child.on("error", () => output.destroy(new Error("Upstream process could not start")));
    child.stdin!.on("error", () => {});
    child.on("close", (code, signal) => {
      if (!cli) process.off("SIGTERM", forwardSignal);
      send(frame("back", cli ? 3 : -2, Buffer.from(JSON.stringify({ type: "exit", code, signal })), true)); output.end();
    });
    return {
      async write(f) {
        if (cli && f.stream === 3) {
          const control = JSON.parse(Buffer.from(f.bytes).toString()) as { type: string; signal?: NodeJS.Signals };
          if (pty) await writeBytes(child.stdio[3] as Writable, Buffer.concat([f.bytes, Buffer.from("\n")]));
          else if (control.type === "signal") child.kill(control.signal);
        } else if (f.bytes.length) {
          try { await writeBytes(child.stdin!, f.bytes); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPIPE" && (error as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED") throw error; }
        }
        else if (f.last) child.stdin!.end();
      },
      async *frames() { for await (const f of output) yield f as Frame; },
      abort() { child.kill("SIGTERM"); child.stdin!.destroy(); output.destroy(); },
    };
  } };
}

export function httpBackend(target: (connection: Parameters<Backend["open"]>[0]) => URL): Backend {
  return { open(connection) {
    const meta = connection.meta as { request: { method: string; headers: string[] } };
    const url = target(connection), headers = [...meta.request.headers];
    for (let i = 0; i < headers.length; i += 2) if (headers[i]!.toLowerCase() === "host") headers[i + 1] = url.host;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: meta.request.method, headers, agent: false });
    const output = new PassThrough({ objectMode: true, highWaterMark: 16 });
    const emit = (f: Frame) => new Promise<void>((resolve, reject) => output.write(f, error => error ? reject(error) : resolve()));
    const head = (res: { statusCode?: number; statusMessage?: string; rawHeaders: string[] }) => frame("back", 1, Buffer.from(JSON.stringify({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.rawHeaders })), true);
    request.on("information", res => { output.write(head(res)); });
    request.once("response", (res: IncomingMessage) => {
      void (async () => {
        await emit(head(res));
        for await (const bytes of res) await emit(frame("back", 2, bytes, false));
        if (res.rawTrailers.length) await emit(frame("back", 4, Buffer.from(JSON.stringify(res.rawTrailers)), true));
        await emit(frame("back", 2, new Uint8Array(), true)); output.end();
      })().catch(() => output.destroy(new Error("Upstream HTTP response aborted")));
    });
    request.on("error", () => output.destroy(new Error("Upstream HTTP connection aborted")));
    request.flushHeaders();
    return {
      async write(f) {
        if (f.stream === 3) {
          const raw = JSON.parse(Buffer.from(f.bytes).toString()) as string[];
          request.addTrailers(Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2]!, raw[i * 2 + 1]!] as [string, string]));
        }
        else if (f.stream === 0) { if (f.bytes.length && !request.write(f.bytes)) await once(request, "drain"); if (f.last) request.end(); }
      },
      async *frames() { for await (const f of output) yield f as Frame; },
      abort() { request.destroy(); output.destroy(); },
    };
  } };
}
