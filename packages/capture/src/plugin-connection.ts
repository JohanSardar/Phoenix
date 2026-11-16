import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { frame, type Link } from "@phoenix/taps";
import { processBackend } from "./upstream.ts";

export type CaptureTarget =
  | { surface: "mcp"; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  | { surface: "cli"; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  | { surface: "http"; url: string; headers?: Record<string, string> };
export interface CaptureObservation {
  request: { body: Uint8Array; head?: { method: string; url: string; headers: string[] } };
  response: { body: Uint8Array; head?: { status: number; headers: string[] } };
}

export async function captureConnection(target: CaptureTarget, connector: string, timeoutMs: number) {
  let link: Link | undefined;
  let id = 0;
  const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
  const request = async (method: string, params: unknown): Promise<CaptureObservation> => {
    const current = ++id;
    const body = JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n";
    let timer: NodeJS.Timeout | undefined;
    try {
      const response = new Promise<string>((resolve, reject) => {
        pending.set(current, { resolve, reject });
        timer = setTimeout(() => reject(new Error("Capture read timed out")), timeoutMs);
      });
      await link!.write(frame("out", current, Buffer.from(body), true));
      return { request: { body: Buffer.from(body) }, response: { body: Buffer.from(await response) } };
    } finally { clearTimeout(timer); pending.delete(current); }
  };
  if (target.surface === "mcp") {
    if (!target.command.length) throw new Error("Capture target needs its own command");
    link = processBackend(target.command, { cwd: target.cwd, env: target.env }).open({ surface: "mcp", connector, meta: {} });
    void (async () => {
      const chunks = new Map<number, Buffer[]>();
      try {
        for await (const f of link!.frames()) {
          if (f.stream < 0) continue;
          const parts = [...chunks.get(f.stream) ?? [], Buffer.from(f.bytes)];
          if (!f.last) { chunks.set(f.stream, parts); continue; }
          chunks.delete(f.stream);
          const body = Buffer.concat(parts).toString();
          if (!body.trim()) continue;
          const message = JSON.parse(body);
          pending.get(message.id)?.resolve(body);
        }
      } catch {} finally {
        for (const p of pending.values()) p.reject(new Error("Capture connection closed"));
      }
    })();
    try {
      const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "phoenix-capture-sidecar", version: "1" } });
      if (JSON.parse(Buffer.from(initialized.response.body).toString()).error) throw new Error("Capture connection initialization failed");
      await link.write(frame("out", ++id, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"), true));
    } catch (error) { link.abort("Capture initialization failed"); throw error; }
  }
  return {
    async call(op: string, args: unknown): Promise<CaptureObservation> {
      if (target.surface === "mcp") {
        if (!op.startsWith("tools/call:")) throw new Error("Capture MCP reads must be tools/call operations");
        return request("tools/call", { name: op.slice(11), arguments: args });
      }
      if (target.surface === "cli") {
        const input = args as { argv?: unknown; stdin?: unknown };
        if (!Array.isArray(input.argv) || !input.argv.every(arg => typeof arg === "string") || input.argv[0] !== op || (input.stdin !== undefined && typeof input.stdin !== "string"))
          throw new Error("Capture CLI reads need argv starting with the operation's command and an optional stdin string");
        if (!target.command.length) throw new Error("Capture target needs its own command");
        const stdin = Buffer.from(input.stdin ?? "");
        const invocation = { argv: input.argv, cwd: target.cwd ?? process.cwd(), env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
        const run = processBackend([...target.command, ...input.argv.slice(1)], { cwd: target.cwd, env: target.env }).open({ surface: "cli", connector, meta: invocation });
        const timer = setTimeout(() => run.abort("Capture read timed out"), timeoutMs);
        try {
          if (stdin.length) await run.write(frame("out", 0, stdin, false));
          await run.write(frame("out", 0, new Uint8Array(), true));
          const streams = new Map<number, Buffer[]>([[1, []], [2, []], [3, []]]);
          for await (const f of run.frames()) streams.get(f.stream)?.push(Buffer.from(f.bytes));
          if (!streams.get(3)!.length) throw new Error("Capture CLI read ended without an exit status");
          const frames = [{ dir: "out", stream: 0, bytes: stdin.toString("base64"), last: true }, ...[1, 2, 3].map(stream => ({ dir: "back", stream, bytes: Buffer.concat(streams.get(stream)!).toString("base64"), last: true }))];
          return { request: { body: Buffer.from(JSON.stringify(invocation)) }, response: { body: Buffer.from(JSON.stringify(frames)) } };
        } finally { clearTimeout(timer); }
      }
      const [method, destination] = op.split(" ");
      const url = new URL(target.url);
      if (!method || destination !== `${url.host}${url.pathname}`) throw new Error("Capture HTTP operation must match the authorized target");
      const input = args as { query?: string; body?: unknown };
      url.search = input.query ?? "";
      const body = input.body == null ? "" : JSON.stringify(input.body);
      const headers = { "accept-encoding": "identity", ...target.headers };
      const response = await new Promise<CaptureObservation["response"]>((resolve, reject) => {
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers, agent: false }, res => {
          const parts: Buffer[] = [];
          res.on("data", part => parts.push(part));
          res.once("error", reject);
          res.once("end", () => resolve({ body: Buffer.concat(parts), head: { status: res.statusCode!, headers: res.rawHeaders } }));
        });
        const timer = setTimeout(() => req.destroy(new Error("Capture read timed out")), timeoutMs);
        req.once("close", () => clearTimeout(timer));
        req.once("error", reject); req.end(body);
      });
      return { request: { body: Buffer.from(body), head: { method, url: url.toString(), headers: Object.entries(headers).flat() } }, response };
    },
    close() { link?.abort("Capture sidecar finished"); },
  };
}
