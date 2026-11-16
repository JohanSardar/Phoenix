import { decodeJson, object, type Decode } from "./json.ts";
import { decodeSse, type SseMessage } from "./mcp.ts";
import { decodeHttpBody, header, type Headers } from "./http.ts";

export type ModelDialectName = "messages" | "chat-completions" | "responses" | "generate-content";
export interface InferenceOperation { method: string; path: string }
export interface ModelSplit { history: unknown; configuration: Record<string, unknown> }
export interface ToolUse { id?: string; name?: string; args?: unknown; result?: unknown }
export interface ModelDialect {
  name: ModelDialectName;
  inferenceOperations: readonly InferenceOperation[];
  isInference(method: string, path: string): boolean;
  split(request: Record<string, unknown>): ModelSplit;
  toolUses(value: unknown): ToolUse[];
  providerState(request: Record<string, unknown>): string[];
  externalAccess(request: Record<string, unknown>): string[];
  isTerminal(event: SseMessage): boolean;
}

function toolUses(value: unknown): ToolUse[] {
  const found: ToolUse[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const v = object(value);
    const fn = object(v.function ?? v.functionCall);
    if (v.type === "tool_use" || v.type === "function_call" || v.functionCall || (typeof v.id === "string" && fn.name)) {
      const args = v.input ?? v.arguments ?? fn.arguments ?? fn.args;
      let parsed = args;
      if (typeof args === "string") { try { parsed = JSON.parse(args); } catch {} }
      const id = v.call_id ?? v.id ?? fn.id;
      found.push({ ...(typeof id === "string" ? { id } : {}), ...(typeof (v.name ?? fn.name) === "string" ? { name: (v.name ?? fn.name) as string } : {}), ...(args !== undefined ? { args: parsed } : {}) });
    }
    if (v.type === "tool_result" || v.type === "function_call_output" || v.role === "tool" || v.functionResponse) {
      const response = object(v.functionResponse);
      const id = v.tool_use_id ?? v.call_id ?? v.tool_call_id ?? response.id;
      found.push({ ...(typeof id === "string" ? { id } : {}), ...(typeof response.name === "string" ? { name: response.name } : {}), result: v.output ?? v.content ?? response.response });
    }
    for (const [key, item] of Object.entries(v)) if (!["input", "arguments", "args", "functionResponse"].includes(key)) visit(item);
  };
  const events = Array.isArray(value) ? value : [value];
  const blocks = new Map<number, { id?: string; name?: string; json: string }>();
  const calls = new Map<string, { id?: string; name?: string; json: string }>();
  for (const event of events) {
    const v = object(event);
    const block = object(v.content_block);
    if (v.type === "content_block_start" && block.type === "tool_use") blocks.set(v.index as number, { id: block.id as string, name: block.name as string, json: "" });
    const delta = object(v.delta);
    const pending = blocks.get(v.index as number);
    if (pending && delta.type === "input_json_delta" && typeof delta.partial_json === "string") pending.json += delta.partial_json;
    for (const choice of Array.isArray(v.choices) ? v.choices : []) {
      const c = object(choice);
      const d = object(c.delta);
      for (const item of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const call = object(item);
        const key = `${c.index ?? 0}:${call.index ?? 0}`;
        const current = calls.get(key) ?? { json: "" };
        const fn = object(call.function);
        if (typeof call.id === "string") current.id = call.id;
        if (typeof fn.name === "string") current.name = fn.name;
        if (typeof fn.arguments === "string") current.json += fn.arguments;
        calls.set(key, current);
      }
    }
    visit(event);
  }
  for (const call of [...blocks.values(), ...calls.values()]) if (call.json) {
    let args: unknown = call.json;
    try { args = JSON.parse(call.json); } catch {}
    found.push({ id: call.id, name: call.name, args });
  }
  const unique: ToolUse[] = [];
  for (const use of found) {
    const index = use.id === undefined ? -1 : unique.findIndex(old => old.id === use.id && ("result" in old) === ("result" in use));
    if (index === -1) unique.push(use);
    else unique[index] = { ...unique[index], ...use };
  }
  return unique;
}

function externalAccess(request: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}/${i}`)); return; }
    if (!value || typeof value !== "object") return;
    const v = object(value);
    if (typeof v.type === "string" && /^(web_search|web_fetch|computer|mcp|code_interpreter|file_search)/.test(v.type)) paths.push(path);
    for (const [key, item] of Object.entries(v)) {
      if (["image_url", "file_url", "video_url", "audio_url"].includes(key) && (typeof item === "string" || typeof object(item).url === "string")) {
        const url = typeof item === "string" ? item : object(item).url as string;
        if (/^https?:/i.test(url)) paths.push(`${path}/${key}`);
      }
      if (key === "source" && object(item).type === "url") paths.push(`${path}/source`);
      visit(item, `${path}/${key}`);
    }
  };
  visit(request, "");
  if (Array.isArray(request.mcp_servers) && request.mcp_servers.length) paths.push("/mcp_servers");
  const providerTools = ["googleSearch", "googleSearchRetrieval", "enterpriseWebSearch", "urlContext", "codeExecution", "computerUse", "googleMaps"];
  const names = new Set(providerTools.flatMap(name => [name, name.replace(/[A-Z]/g, c => "_" + c.toLowerCase())]));
  if (Array.isArray(request.tools)) request.tools.forEach((tool, i) => { for (const key of Object.keys(object(tool))) if (names.has(key)) paths.push(`/tools/${i}/${key}`); });
  return [...new Set(paths)];
}

function dialect(name: ModelDialectName, inferenceOperations: InferenceOperation[], historyKey: string, systemRoles: boolean): ModelDialect {
  return {
    name, inferenceOperations,
    isInference: (method, path) => inferenceOperations.some(op => op.method === method.toUpperCase() && new RegExp("^" + op.path.split("{model}").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$").test(path.split("?")[0]!)),
    split(request) {
      const { [historyKey]: history, ...configuration } = request;
      if (!systemRoles || !Array.isArray(history)) return { history, configuration };
      const system = history.filter(item => ["system", "developer"].includes(object(item).role as string));
      return { history: history.filter(item => !["system", "developer"].includes(object(item).role as string)), configuration: { ...configuration, ...(system.length ? { system } : {}) } };
    },
    toolUses,
    providerState: request => ["previous_response_id", "conversation", "cachedContent"].filter(key => request[key] !== undefined && request[key] !== null),
    externalAccess,
    isTerminal(event) {
      if (name === "chat-completions") return event.data === "[DONE]";
      const decoded = decodeJson(new TextEncoder().encode(event.data));
      if (!decoded.ok) return false;
      const value = object(decoded.value);
      if (name === "messages") return value.type === "message_stop";
      if (name === "responses") return ["response.completed", "response.failed", "response.incomplete"].some(type => value.type === type && object(value.response).status === type.slice("response.".length));
      return false;
    },
  };
}

export const modelDialects: Readonly<Record<ModelDialectName, ModelDialect>> = {
  messages: dialect("messages", [{ method: "POST", path: "/v1/messages" }], "messages", false),
  "chat-completions": dialect("chat-completions", [{ method: "POST", path: "/v1/chat/completions" }], "messages", true),
  responses: dialect("responses", [{ method: "POST", path: "/v1/responses" }], "input", true),
  "generate-content": dialect("generate-content", [{ method: "POST", path: "/v1beta/models/{model}:generateContent" }, { method: "POST", path: "/v1beta/models/{model}:streamGenerateContent" }], "contents", false),
};

export function modelStreamComplete(name: ModelDialectName, bytes: Uint8Array, headers: Headers): boolean {
  if (!header(headers, "content-type")?.toLowerCase().includes("text/event-stream")) return false;
  const body = decodeHttpBody(bytes, headers);
  if (!body.ok) return false;
  const sse = decodeSse(body.value);
  return sse.ok && sse.value.some(event => modelDialects[name].isTerminal(event));
}

export function decodeModelBody(bytes: Uint8Array, contentType: string): Decode<unknown[]> {
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const decoded = decodeJson(bytes);
    return decoded.ok ? { ok: true, value: [decoded.value] } : decoded;
  }
  const sse = decodeSse(bytes);
  if (!sse.ok) return sse;
  const values: unknown[] = [];
  for (const event of sse.value) {
    if (!event.data || event.data === "[DONE]") continue;
    const decoded = decodeJson(new TextEncoder().encode(event.data));
    if (!decoded.ok) return { ok: false, why: decoded.why, bytes };
    values.push(decoded.value);
  }
  return { ok: true, value: values };
}
