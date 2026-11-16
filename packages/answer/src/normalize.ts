import { callKey, canonicalJson, decodeJson, decodeMcp, mcpInfo, object, type HttpRequest, type RpcMessage, type Surface } from "@phoenix/wire";
import type { Call, CallMessage, ConnectorPolicy } from "./types.ts";

export interface McpShape { message: RpcMessage; op?: string; args: unknown }

export function mcpShape(bytes: Uint8Array): McpShape | undefined {
  const decoded = decodeMcp(bytes);
  if (!decoded.ok) return undefined;
  const message = decoded.value;
  const params = object(message.params);
  const { _meta, ...rest } = params;
  const op = mcpInfo(message).op;
  return { message, ...(op ? { op } : {}), args: message.method === "tools/call" ? params.arguments ?? {} : rest };
}

export function httpHost(request: HttpRequest): string {
  let host = request.authority;
  for (let i = 0; i < request.headers.length; i += 2) if (!host && request.headers[i]!.toLowerCase() === "host") host = request.headers[i + 1];
  if (/^[a-z]+:\/\//i.test(request.url)) host = new URL(request.url).host;
  return (host ?? "").replace(/:(80|443)$/, "").toLowerCase();
}

export function httpShape(request: HttpRequest, body: Uint8Array): { op: string; path: string; args: unknown } {
  const url = new URL(request.url, "http://x");
  const decoded = decodeJson(body);
  const text = (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { return undefined; } })();
  const content = !body.length ? null : decoded.ok ? decoded.value : text !== undefined ? text : { base64: Buffer.from(body).toString("base64") };
  return { op: `${request.method.toUpperCase()} ${httpHost(request)}${url.pathname}`, path: url.pathname, args: { query: url.search, body: content } };
}

export function isReadOnly(policy: ConnectorPolicy, surface: Surface, op: string, args?: unknown): boolean {
  if (surface === "mcp" && !op.startsWith("tools/call:")) return true;
  const argv = surface === "cli" ? (args as { argv?: unknown[] } | undefined)?.argv : undefined;
  return (policy.read_only ?? []).some(entry => entry.op === op || (Array.isArray(argv) && argv[0] === op && entry.op.split(" ").every((word, i) => argv[i] === word)));
}

export function toCall(input: { surface: Surface; layer?: "agent" | "under"; connector: string; op: string; args: unknown; raw: CallMessage }, policy: ConnectorPolicy): Call {
  return {
    surface: input.surface, layer: input.layer ?? "agent", connector: input.connector, op: input.op, args: input.args, raw: input.raw,
    key: callKey({ surface: input.surface, connector: input.connector, op: input.op, args: input.args }),
    readOnly: isReadOnly(policy, input.surface, input.op, input.args),
  };
}

export function sameReply(recorded: Uint8Array, actual: Uint8Array): boolean {
  const a = decodeMcp(recorded), b = decodeMcp(actual);
  if (!a.ok || !b.ok) return false;
  return canonicalJson({ result: a.value.result ?? null, error: a.value.error ?? null }) === canonicalJson({ result: b.value.result ?? null, error: b.value.error ?? null });
}
