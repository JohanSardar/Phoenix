import { request } from "node:http";
import { setTimeout } from "node:timers/promises";
import type { EngineChannel } from "@phoenix/sandbox";
import type { HarnessContract } from "@phoenix/formats";

export async function submitTask(channel: EngineChannel, run: Extract<HarnessContract["run"], { serve: string[] }>, prompt: string, signal?: AbortSignal): Promise<{ kind: "finished"; code: number }> {
  const [method, ...parts] = run.ready.http.split(" ");
  const ready = new URL(parts.join(" "), "http://localhost");
  if (ready.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(ready.hostname)) throw new Error("Server ready URL must be HTTP on container loopback");
  const call = (url: URL, method: string, body?: string): Promise<number> => new Promise((resolve, reject) => {
    const req = request(url, { method, signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]), createConnection: () => channel.connect(Number(url.port || 80)), headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 500)); response.once("error", reject); });
    req.once("error", reject);
    req.end(body);
  });
  const deadline = performance.now() + 30000;
  for (;;) {
    try { if (await call(ready, method ?? "GET") < 400) break; } catch {}
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error("Harness server did not become ready");
    await setTimeout(100, undefined, { signal });
  }
  const submit = run.submit.http;
  const url = new URL(submit.path, ready.origin);
  if (url.origin !== ready.origin) throw new Error("Server submit must use the ready endpoint's origin");
  const code = await call(url, submit.method, submit.body?.replaceAll("{task}", prompt));
  return { kind: "finished", code: code < 400 ? 0 : 1 };
}
