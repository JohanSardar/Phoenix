import { writeClockFile } from "@phoenix/sandbox";
import type { InstalledPlugin } from "./discovery.ts";
import { startPlugin, PluginProcessError, type PluginReply, type PluginStartOptions } from "./process.ts";

export interface PluginWireMessage {
  body: Uint8Array;
  head?: { status: number; statusMessage?: string; headers: readonly string[] };
}

export interface PluginCall {
  surface: "mcp" | "http" | "cli";
  layer: "agent" | "under";
  op: string;
  args: unknown;
  raw: { body: Uint8Array; head?: object };
}

export type ServingOptions = Omit<PluginStartOptions, "onConnection" | "replay"> & { replay: NonNullable<PluginStartOptions["replay"]> };
export type ServingReply = { status: "answer"; value: PluginWireMessage } | Exclude<PluginReply, { status: "answer" }>;
export interface ServingPlugin {
  call(call: PluginCall, now: string): Promise<ServingReply>;
  state(now: string): Promise<PluginReply>;
  stop(): Promise<void>;
}

export async function startServingPlugin(plugin: InstalledPlugin, options: ServingOptions, now: string): Promise<ServingPlugin> {
  await writeClockFile(options.replay.spec.clockFile, now);
  const session = await startPlugin(plugin, "serve", {
    ...options,
    context: { ...options.context, now: "file:///phoenix-clock" },
    replay: { ...options.replay, spec: { ...options.replay.spec, virtualTime: now } },
    onConnection: ({ stream }) => stream.destroy(),
  });
  let tail: Promise<unknown> = Promise.resolve();
  const request = (method: "call" | "state", params: Record<string, unknown>, time: string): Promise<PluginReply> => {
    const result = tail.then(async () => {
      await writeClockFile(options.replay.spec.clockFile, time);
      return session.request(method, { ...params, now: time });
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    async call(call, time) {
      const level = plugin.descriptor.serve!.level;
      if ((level === "http") !== (call.surface === "http") || !plugin.descriptor.operations.includes(call.op))
        return { status: "unsupported", reason: "Operation or surface is not covered by the plugin" };
      const reply = await request("call", { surface: call.surface, layer: call.layer, op: call.op, args: call.args, raw: { ...call.raw, body: Buffer.from(call.raw.body).toString("base64") } }, time);
      if (reply.status !== "answer") return reply;
      const value = reply.value as { body?: unknown; head?: PluginWireMessage["head"] } | null;
      if (!value || typeof value.body !== "string" || Buffer.from(value.body, "base64").toString("base64") !== value.body)
        throw new PluginProcessError("Plugin answer must contain a base64 wire body");
      const head = value.head;
      if (call.surface === "http" && (!head || !Number.isInteger(head.status) || head.status < 100 || head.status > 599 || !Array.isArray(head.headers) || head.headers.length % 2 !== 0 || !head.headers.every(h => typeof h === "string") || (head.statusMessage !== undefined && typeof head.statusMessage !== "string")))
        throw new PluginProcessError("Plugin answer has an invalid HTTP response head");
      const body = Buffer.from(value.body, "base64");
      if (call.surface === "mcp") {
        let response: Record<string, unknown>, input: Record<string, unknown>;
        try { response = JSON.parse(body.toString("utf8")); input = JSON.parse(Buffer.from(call.raw.body).toString("utf8")); }
        catch { throw new PluginProcessError("Plugin answer is not JSON-RPC"); }
        if (!response || response.jsonrpc !== "2.0" || response.id !== input.id || (("result" in response) === ("error" in response)) || "method" in response)
          throw new PluginProcessError("Plugin answer has an invalid JSON-RPC response envelope");
        if ("error" in response) {
          const error = response.error as { code?: unknown; message?: unknown } | null;
          if (!error || typeof error !== "object" || !Number.isInteger(error.code) || typeof error.message !== "string")
            throw new PluginProcessError("Plugin answer has an invalid JSON-RPC error");
        }
      }
      return { status: "answer", value: { body, ...(head ? { head } : {}) } };
    },
    state: time => request("state", {}, time),
    stop: () => session.stop(),
  };
}
