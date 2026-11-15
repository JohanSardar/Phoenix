import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startPlugin, type InstalledPlugin, type PluginSession } from "@phoenix/plugin-host";
import { appendCoverage, BlobStore, createTraceWriter, readCapture } from "@phoenix/store";
import { sanitizeMessage, secretPolicy } from "./secrets.ts";
import { captureConnection, type CaptureTarget } from "./plugin-connection.ts";

export interface PluginCaptureOptions {
  root: string;
  home: string;
  connector: string;
  plugin: InstalledPlugin;
  target: CaptureTarget;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export async function capturePlugin(options: PluginCaptureOptions): Promise<void> {
  const { root, connector, plugin } = options;
  const capture = await readCapture(root);
  const stream = `prefetch-${randomUUID()}`;
  const writer = createTraceWriter(root, { capture: capture.metadata.capture, stream });
  const blobs = new BlobStore(root), policy = await secretPolicy(options.home);
  const from = new Date().toISOString();
  let session: PluginSession | undefined;
  let connection: Awaited<ReturnType<typeof captureConnection>> | undefined;
  let seq = 0;
  try {
    if (plugin.descriptor.connector !== connector) throw new Error("Capture plugin connector mismatch");
    const streams = new Set(capture.allEvents.filter(e => e.connector === connector).map(e => e.stream));
    const segments = (await readdir(join(root, "seg"))).filter(name => name.endsWith(".jsonl") && [...streams].some(stream => name.startsWith(`${stream}.`))).map(name => join(root, "seg", name));
    session = await startPlugin(plugin, "capture", { context: { segments }, env: options.env, timeoutMs: options.timeoutMs });
    const plan = await session.request("capture", { phase: "plan", connector });
    if (plan.status !== "answer") throw new Error("Capture plugin did not produce a read plan");
    const calls = (plan.value as { calls?: { op: string; args: unknown }[] })?.calls;
    if (!Array.isArray(calls)) throw new Error("Capture plan needs calls");
    if (calls.some(call => !call || typeof call.op !== "string" || !plugin.descriptor.read_only?.includes(call.op))) throw new Error("Capture request is not declared read-only");
    connection = await captureConnection(options.target, connector, options.timeoutMs ?? 30_000);
    const results: { op: string; args: unknown; observation: unknown }[] = [];
    for (const call of calls) {
      const observation = await connection.call(call.op, call.args);
      const ts = { wall: new Date().toISOString(), mono: process.hrtime.bigint().toString() };
      const messages = await Promise.all([observation.request, observation.response].map(async message => {
        let bytes = message.body;
        const embedded: Awaited<ReturnType<typeof sanitizeMessage>>[] = [];
        if (options.target.surface === "mcp") {
          const envelope = JSON.parse(Buffer.from(bytes).toString());
          let changed = false;
          for (const item of envelope.result?.content ?? []) if (item.type === "text" && typeof item.text === "string") {
            const stripped = await sanitizeMessage({ body: Buffer.from(item.text) }, policy);
            embedded.push(stripped);
            const text = Buffer.from(stripped.msg.body!).toString();
            if (text !== item.text) { item.text = text; changed = true; }
          }
          if (changed) bytes = Buffer.from(JSON.stringify(envelope) + "\n");
        }
        const headers = message.head?.headers ?? [];
        const header = (name: string) => { for (let i = 0; i < headers.length; i += 2) if (headers[i]!.toLowerCase() === name) return headers[i + 1]; return undefined; };
        const result = await sanitizeMessage({ body: bytes, contentType: header("content-type"), contentEncoding: header("content-encoding") }, policy);
        result.changes.push(...embedded.flatMap(r => r.changes));
        result.unscanned.push(...embedded.flatMap(r => r.unscanned));
        let body: string, body_encoding: "base64" | undefined;
        try { body = new TextDecoder("utf-8", { fatal: true }).decode(result.msg.body!); }
        catch { body = Buffer.from(result.msg.body!).toString("base64"); body_encoding = "base64"; }
        return { message: { ...message, body, ...(body_encoding ? { body_encoding } : {}), ...(result.originalEncoding ? { contentEncoding: result.originalEncoding } : {}) }, result };
      }));
      const sanitized = await sanitizeMessage({ body: Buffer.from(JSON.stringify({ op: call.op, args: call.args, request: messages[0]!.message, response: messages[1]!.message })) }, policy);
      const clean = JSON.parse(Buffer.from(sanitized.msg.body!).toString()) as { op: string; args: unknown; request: unknown; response: unknown };
      const body = await blobs.put(sanitized.msg.body!);
      if (writer.append({ v: 1, capture: capture.metadata.capture, stream, seq: seq++, ts, kind: "prefetch", connector, surface: options.target.surface, op: call.op,
        provenance: "recorded", body: { blob: body }, secrets: sanitized.unscanned.length || messages.some(m => m.result.unscanned.length) ? "unscanned" : [...sanitized.changes, ...messages.flatMap(m => m.result.changes)] }) === "dropped") throw new Error("Prefetch recording dropped");
      await writer.drain();
      results.push({ op: call.op, args: clean.args, observation: { request: clean.request, response: clean.response } });
    }
    const finished = await session.request("capture", { phase: "complete", results });
    if (finished.status !== "answer") throw new Error("Capture plugin did not produce coverage");
    const coverage = (finished.value as { collections?: { entity: string; complete: boolean }[] })?.collections;
    if (!Array.isArray(coverage) || coverage.some(c => typeof c.entity !== "string" || typeof c.complete !== "boolean")) throw new Error("Invalid capture coverage");
    await writer.close();
    const statement = await sanitizeMessage({ body: Buffer.from(JSON.stringify({ route: "plugin", connector, state: "complete", from, to: new Date().toISOString(), calls: results.length, collections: coverage })) }, policy);
    await appendCoverage(root, JSON.parse(Buffer.from(statement.msg.body!).toString()));
  } catch (error) {
    await writer.close().catch(() => {});
    await appendCoverage(root, { route: "plugin", connector, state: "incomplete", from, to: new Date().toISOString(), calls: seq });
    throw error;
  } finally { connection?.close(); await session?.stop(); }
}
