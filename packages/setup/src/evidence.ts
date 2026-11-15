import type { TraceEvent } from "@phoenix/formats";
import { canonicalJson, decodeCliInvocation, decodeHttpBody, decodeJson, decodeMcp, decodeModelBody, mcpInfo, modelDialects, object, type RpcMessage, type Surface } from "@phoenix/wire";

export type Body = (event: TraceEvent) => Promise<Uint8Array | undefined>;
export const eventId = (e: TraceEvent): string => e.id ?? `${e.stream}:${e.seq}`;

export interface McpCall { connector: string; call: TraceEvent; request: RpcMessage; op: string; result?: { event: TraceEvent; message: RpcMessage } }
export interface ModelExchange { connector: string; request: { event: TraceEvent; value: Record<string, unknown> }; response?: { event: TraceEvent; values: unknown[] } }
export interface CliCall { connector: string; event: TraceEvent; argv: string[] }
export interface HttpCall { connector: string; method: string; op: string; response?: { status: number; body?: unknown } }
export interface ToolDefinition { name: string; description?: string; schema?: unknown }
export interface ToolUse { name: string; id?: string; args: unknown; event: TraceEvent; result?: { text: string; event: TraceEvent } }

export interface RunEvidence {
  surfaces: Map<string, { surface: Surface; routes: Set<string> }>;
  mcp: McpCall[];
  initialize: Map<string, RpcMessage>;
  toolLists: Map<string, unknown[]>;
  models: ModelExchange[];
  cli: CliCall[];
  http: HttpCall[];
  toolUses: ToolUse[];
  definitions?: { event: TraceEvent; tools: ToolDefinition[] };
}

const json = (bytes: Uint8Array | undefined): unknown => {
  if (!bytes) return undefined;
  const decoded = decodeJson(bytes);
  return decoded.ok ? decoded.value : undefined;
};

const header = (headers: readonly string[], name: string) => headers.find((_, i) => i % 2 === 1 && headers[i - 1]!.toLowerCase() === name);

const isModelRequest = (value: unknown): value is Record<string, unknown> => {
  const v = object(value);
  return typeof v.model === "string" && (Array.isArray(v.input) || typeof v.input === "string" || Array.isArray(v.messages) || Array.isArray(v.contents));
};

export function toolDefinitions(request: Record<string, unknown>): ToolDefinition[] {
  const found: ToolDefinition[] = [];
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    const t = object(tool), fn = object(t.function);
    for (const d of Array.isArray(t.functionDeclarations) ? t.functionDeclarations.map(object) : [typeof fn.name === "string" ? fn : t]) {
      if (typeof d.name !== "string") continue;
      found.push({ name: d.name, ...(typeof d.description === "string" ? { description: d.description } : {}), schema: d.parameters ?? d.input_schema ?? d.parametersJsonSchema ?? d.inputSchema });
    }
  }
  return found;
}

export async function readEvidence(events: readonly TraceEvent[], body: Body): Promise<RunEvidence> {
  const evidence: RunEvidence = { surfaces: new Map(), mcp: [], initialize: new Map(), toolLists: new Map(), models: [], cli: [], http: [], toolUses: [] };
  const streams = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (!e.connector || !e.surface || e.layer === "under") continue;
    const seen = evidence.surfaces.get(e.connector) ?? { surface: e.surface, routes: new Set<string>() };
    seen.routes.add(e.route ?? "tap");
    evidence.surfaces.set(e.connector, seen);
    streams.set(e.stream, [...streams.get(e.stream) ?? [], e]);
  }
  for (const list of streams.values()) {
    const connector = list[0]!.connector!, surface = list[0]!.surface!;
    if (surface === "mcp") {
      const open = new Map<string, McpCall>();
      for (const e of list) {
        if (e.kind !== "call" && e.kind !== "result") continue;
        const decoded = decodeMcp((await body(e)) ?? new Uint8Array());
        if (!decoded.ok) continue;
        const message = decoded.value, id = JSON.stringify(message.id);
        if (e.kind === "call" && message.method && "id" in message) {
          const call: McpCall = { connector, call: e, request: message, op: mcpInfo(message).op! };
          open.set(id, call); evidence.mcp.push(call);
        } else if (e.kind === "result" && !message.method && open.has(id)) {
          const call = open.get(id)!;
          open.delete(id);
          if (e.partial || call.call.partial) continue;
          call.result = { event: e, message };
          const result = object(message.result);
          if (call.op === "initialize" && message.result) evidence.initialize.set(connector, message);
          if (call.op === "tools/list" && Array.isArray(result.tools)) evidence.toolLists.set(connector, [...evidence.toolLists.get(connector) ?? [], ...result.tools]);
        }
      }
      continue;
    }
    const opened = list.find(e => e.kind === "meta" && e.op === "open");
    const meta = object(object(json(opened && await body(opened))).meta);
    if (surface === "cli") {
      try { evidence.cli.push({ connector, event: opened!, argv: decodeCliInvocation(new TextEncoder().encode(JSON.stringify(meta))).argv }); } catch {}
      continue;
    }
    const call = list.find(e => e.kind === "call" && !e.partial);
    const result = list.find(e => e.kind === "result" && !e.partial);
    const head = object(json(await (async () => { const e = list.find(e => e.kind === "meta" && e.op?.startsWith("frame:back:")); return e && body(e); })()));
    const headers = Array.isArray(head.headers) ? head.headers as string[] : [];
    let responseBody = result ? await body(result) : undefined;
    if (responseBody && !result!.body?.content_encoding) {
      const decoded = decodeHttpBody(responseBody, headers);
      responseBody = decoded.ok ? decoded.value : undefined;
    }
    const requestValue = json(call && await body(call));
    if (isModelRequest(requestValue)) {
      const values = responseBody && decodeModelBody(responseBody, header(headers, "content-type") ?? "application/json");
      evidence.models.push({ connector, request: { event: call!, value: requestValue }, ...(values && values.ok ? { response: { event: result!, values: values.value } } : {}) });
      continue;
    }
    const request = object(meta.request), requestHeaders = Array.isArray(request.headers) ? request.headers as string[] : [];
    const method = String(request.method ?? "GET").toUpperCase(), url = new URL(String(request.url ?? "/"), "http://x");
    const host = (header(requestHeaders, "host") ?? "").replace(/:(80|443)$/, "").toLowerCase();
    evidence.http.push({
      connector, method, op: `${method} ${host}${url.pathname}`,
      ...(typeof head.status === "number" ? { response: { status: head.status, ...(json(responseBody) !== undefined ? { body: json(responseBody) } : {}) } } : {}),
    });
  }
  const outputs = new Map<string, { text: string; event: TraceEvent }>();
  for (const exchange of evidence.models) {
    const tools = toolDefinitions(exchange.request.value);
    if (!evidence.definitions && tools.length) evidence.definitions = { event: exchange.request.event, tools };
    const v = exchange.request.value;
    for (const use of modelDialects.responses.toolUses([v.input, v.messages, v.contents].flatMap((h) => Array.isArray(h) ? h : []))) {
      if (!use.id || !("result" in use) || outputs.has(use.id)) continue;
      const value = typeof use.result === "string" ? use.result : Array.isArray(use.result) ? use.result.map(part => object(part).text).filter(t => typeof t === "string").join("") : undefined;
      if (value !== undefined) outputs.set(use.id, { text: value, event: exchange.request.event });
    }
  }
  for (const exchange of evidence.models) {
    if (!exchange.response) continue;
    for (const use of modelDialects.responses.toolUses(exchange.response.values))
      if (use.name && !("result" in use)) evidence.toolUses.push({ name: use.name, ...(use.id ? { id: use.id } : {}), args: use.args ?? {}, event: exchange.response.event, ...(use.id && outputs.has(use.id) ? { result: outputs.get(use.id)! } : {}) });
  }
  return evidence;
}

export function attributeToolUse(use: ToolUse, evidence: RunEvidence, tools: ReadonlyMap<string, readonly unknown[]>): { connector: string; tool: string } | undefined {
  const definition = evidence.definitions?.tools.find(d => d.name === use.name);
  if (!definition) return undefined;
  const matches: { connector: string; tool: string }[] = [];
  for (const [connector, list] of tools) for (const tool of list.map(object)) {
    if (typeof tool.name === "string" && (tool.description ?? null) === (definition.description ?? null) && canonicalJson(tool.inputSchema ?? null) === canonicalJson(definition.schema ?? null))
      matches.push({ connector, tool: tool.name });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
