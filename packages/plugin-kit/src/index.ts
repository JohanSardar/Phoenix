import { startServingPlugin, type InstalledPlugin, type PluginCall, type PluginWireMessage, type ServingOptions } from "@phoenix/plugin-host";
import { canonicalJson, decodeJson } from "@phoenix/wire";

export interface RecordedPluginExchange {
  id: string;
  surface: PluginCall["surface"];
  layer: PluginCall["layer"];
  op: string;
  args: unknown;
  request: PluginCall["raw"];
  stdin?: Uint8Array;
  response: PluginWireMessage;
  observedAt: string;
  during?: readonly unknown[];
  after?: readonly unknown[];
}

export interface PluginDifference {
  exchange?: string;
  kind: "content" | "protocol" | "end-state";
  path: string;
  expected?: unknown;
  actual?: unknown;
}

export interface PluginReport {
  connector: string;
  attempted: number;
  matched: number;
  differences: PluginDifference[];
  endState?: unknown;
}

export async function runPluginKit(options: {
  plugin: InstalledPlugin;
  start: ServingOptions;
  now: string;
  exchanges: readonly RecordedPluginExchange[];
  endState?: unknown;
}): Promise<PluginReport> {
  const report: PluginReport = { connector: options.plugin.descriptor.connector, attempted: 0, matched: 0, differences: [] };
  const plugin = await startServingPlugin(options.plugin, options.start, options.now);
  const diff = (expected: unknown, actual: unknown, path: string, kind: PluginDifference["kind"], exchange?: string): void => {
    if (canonicalJson(expected ?? null) === canonicalJson(actual ?? null) && (expected === undefined) === (actual === undefined)) return;
    if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object" && Array.isArray(expected) === Array.isArray(actual)) {
      const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, kind, exchange);
      return;
    }
    report.differences.push({ ...(exchange ? { exchange } : {}), kind, path, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
  };
  let now = options.now;
  try {
    for (const exchange of options.exchanges) {
      now = exchange.observedAt;
      const before = report.differences.length;
      report.attempted++;
      try {
        const { stdin, ...call } = exchange;
        const reply = await plugin.call({ ...call, raw: exchange.request, ...(stdin ? { stdin: async () => stdin } : {}) }, now);
        if (reply.status !== "answer") {
          report.differences.push({ exchange: exchange.id, kind: "protocol", path: "/outcome", expected: "answer", actual: reply });
          continue;
        }
        diff(exchange.response.head, reply.value.head, "/head", "protocol", exchange.id);
        const a = decodeJson(exchange.response.body), b = decodeJson(reply.value.body);
        if (a.ok && b.ok) diff(a.value, b.value, "/body", "content", exchange.id);
        if (!Buffer.from(exchange.response.body).equals(reply.value.body))
          report.differences.push({ exchange: exchange.id, kind: "content", path: "/wire/body", expected: Buffer.from(exchange.response.body).toString("base64"), actual: Buffer.from(reply.value.body).toString("base64") });
        if (exchange.during?.length || exchange.after?.length)
          report.differences.push({ exchange: exchange.id, kind: "protocol", path: "/messages", expected: { during: exchange.during, after: exchange.after }, actual: "The plugin call protocol returns one response, with no unsolicited messages" });
        if (before === report.differences.length) report.matched++;
      } catch (error) {
        report.differences.push({ exchange: exchange.id, kind: "protocol", path: "/execution", expected: "answer", actual: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      const state = await plugin.state(now);
      if (state.status === "answer") {
        report.endState = state.value;
        if (Object.hasOwn(options, "endState")) diff(options.endState, state.value, "/state", "end-state");
      } else report.differences.push({ kind: "end-state", path: "/outcome", expected: "answer", actual: state });
    } catch (error) {
      report.differences.push({ kind: "end-state", path: "/execution", expected: "answer", actual: error instanceof Error ? error.message : String(error) });
    }
    return report;
  } finally { await plugin.stop(); }
}
