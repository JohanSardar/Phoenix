import { parse } from "yaml";
import type { MomentManifest, PluginDescriptor } from "@phoenix/formats";
import type { InstalledPlugin } from "@phoenix/plugin-host";
import { inferToolFormat, mcpInfo, object } from "@phoenix/wire";
import type { RunEvidence } from "./evidence.ts";

export type Connector = NonNullable<MomentManifest["connectors"]>[string];
type Surface = Connector["surface"];

export function recognizes(descriptor: PluginDescriptor, name: string, surface: Surface, hosts: readonly string[]): boolean {
  if (descriptor.connector === name) return true;
  const r = descriptor.recognize;
  if (surface === "mcp") return r.mcp_servers?.includes(name) ?? false;
  if (surface === "cli") return r.commands?.includes(name) ?? false;
  return hosts.some(host => r.hosts?.includes(host));
}

export function harnessMcpServers(files: ReadonlyMap<string, string>): string[] {
  const contract = files.get("phoenix.harness.yaml");
  if (!contract) return [];
  const mcp = object(object(object(parse(contract)).endpoints).mcp);
  if (mcp.format !== "mcpServers" || typeof mcp.file !== "string" || !files.has(mcp.file)) return [];
  return Object.keys(object(object(JSON.parse(files.get(mcp.file)!)).mcpServers));
}

export function discoverConnectors(evidence: RunEvidence, harnessServers: readonly string[]): Record<string, Connector> {
  const models = new Set(evidence.models.map(m => m.connector));
  const connectors: Record<string, Connector> = {};
  for (const [name, { surface, routes }] of evidence.surfaces) {
    if (models.has(name) && !evidence.http.some(h => h.connector === name)) continue;
    const initialize = evidence.initialize.get(name);
    const info = initialize ? mcpInfo(initialize) : {};
    const tools = evidence.toolLists.get(name);
    connectors[name] = {
      surface, routes: [...routes].sort(), tier: "recorded", origin: "captured", read_only: [],
      ...(tools ? { tools: tools.map(object) } : {}),
      ...(info.version ? { mcp: { protocol_version: info.version, era: info.era! } } : {}),
      data: [{ path: "data/run.jsonl", kind: "run-evidence" }],
    };
  }
  for (const name of harnessServers) {
    if (connectors[name]) continue;
    connectors[name] = { surface: "mcp", routes: [], tier: "recorded", origin: "captured", read_only: [], coverage: { recorded: false, witness: "model-api" }, data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  }
  return connectors;
}

export function modelIdentifier(evidence: RunEvidence): MomentManifest["model"] {
  for (const exchange of evidence.models) {
    const reported = exchange.response?.values.map(v => object(v).model ?? object(object(v).response).model).find(m => typeof m === "string");
    if (typeof reported === "string") return { id: reported };
    if (typeof exchange.request.value.model === "string") return { id: exchange.request.value.model };
  }
  return undefined;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

export function classify(name: string, connector: Connector, evidence: RunEvidence, plugins: readonly InstalledPlugin[]): { read_only: NonNullable<Connector["read_only"]>; plugin?: InstalledPlugin } {
  const hosts = [...new Set(evidence.http.filter(h => h.connector === name).map(h => h.op.split(" ")[1]!.split("/")[0]!))];
  const plugin = plugins.find(p => recognizes(p.descriptor, name, connector.surface, hosts));
  if (plugin) return { read_only: (plugin.descriptor.read_only ?? []).map(op => ({ op, source: "plugin" as const })), plugin };
  if (connector.surface === "mcp")
    return { read_only: (connector.tools ?? []).filter(t => object(t.annotations).readOnlyHint === true && typeof t.name === "string").map(t => ({ op: `tools/call:${t.name}`, source: "annotation" as const })) };
  if (connector.surface === "http")
    return { read_only: [...new Set(evidence.http.filter(h => h.connector === name && SAFE.has(h.method)).map(h => h.op))].map(op => ({ op, source: "http-safe-method" as const })) };
  return { read_only: [] };
}

const RANK = { synthesized: 0, recorded: 1, stateful: 2 } as const;

export function pickTier(connector: Connector, plugin: InstalledPlugin | undefined, synthesizedFills: boolean): Connector["tier"] {
  if (synthesizedFills) return "synthesized";
  if (!plugin) return "recorded";
  const supported = object(connector.coverage).complete === true ? "stateful" : "recorded";
  return RANK[plugin.descriptor.tier] < RANK[supported] ? plugin.descriptor.tier : supported;
}

export function inferFormats(name: string, connector: Connector, evidence: RunEvidence): Record<string, { schema: unknown; disagreements: unknown[] }> | undefined {
  const samples = new Map<string, unknown[]>();
  const add = (op: string, value: unknown) => samples.set(op, [...samples.get(op) ?? [], value]);
  for (const call of evidence.mcp) if (call.connector === name && call.op.startsWith("tools/call:") && call.result?.message.result !== undefined) add(call.op, call.result.message.result);
  for (const call of evidence.http) if (call.connector === name && call.response?.body !== undefined) add(call.op, call.response.body);
  if (!samples.size) return undefined;
  const declared = new Map((connector.tools ?? []).map(t => [`tools/call:${t.name}`, t.outputSchema as object | boolean | undefined]));
  return Object.fromEntries([...samples].map(([op, values]) => {
    const schema = declared.get(op);
    const structured = values.map(v => object(v).structuredContent);
    const result = inferToolFormat(values);
    const disagreements = schema === undefined ? [] : inferToolFormat(structured, schema).disagreements;
    return [op, { schema: result.schema, ...(schema === undefined ? {} : { outputSchema: schema }), disagreements }];
  }));
}
