import { createParser } from "eventsource-parser";
import { decodeJson, encodeJson, object, type Decode } from "./json.ts";

export type McpEra = "initialization" | "per-request";
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export function decodeMcp(bytes: Uint8Array): Decode<RpcMessage> {
  const decoded = decodeJson(bytes);
  if (!decoded.ok) return decoded;
  const msg = object(decoded.value);
  if (msg.jsonrpc !== "2.0" || !(typeof msg.method === "string" || "result" in msg || "error" in msg))
    return { ok: false, why: "Not a JSON-RPC message", bytes };
  return { ok: true, value: msg as RpcMessage };
}

export const encodeMcp = (message: RpcMessage): Uint8Array => new Uint8Array([...encodeJson(message), 10]);

export function mcpInfo(message: RpcMessage): { op?: string; version?: string; era?: McpEra; toolUseId?: string | number | null } {
  const params = object(message.params);
  const meta = object(params._meta);
  const result = object(message.result);
  const version = meta["io.modelcontextprotocol/protocolVersion"] ?? params.protocolVersion ?? result.protocolVersion;
  return {
    ...(message.method ? { op: message.method === "tools/call" && typeof params.name === "string" ? `tools/call:${params.name}` : message.method } : {}),
    ...(typeof version === "string" ? { version, era: version >= "2026-07-28" ? "per-request" as const : "initialization" as const } : {}),
    ...("id" in message ? { toolUseId: message.id } : {}),
  };
}

export function lineFragments(bytes: Uint8Array): { bytes: Uint8Array; last: boolean }[] {
  const parts: { bytes: Uint8Array; last: boolean }[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
    parts.push({ bytes: bytes.subarray(start, i + 1), last: true });
    start = i + 1;
  }
  if (start < bytes.length) parts.push({ bytes: bytes.subarray(start), last: false });
  return parts;
}

export interface SseMessage { event?: string; data: string; id?: string }

export function decodeSse(bytes: Uint8Array): Decode<SseMessage[]> {
  try {
    const events: SseMessage[] = [];
    const parser = createParser({ onEvent: event => events.push(event) });
    parser.feed(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { ok: true, value: events };
  } catch {
    return { ok: false, why: "Invalid UTF-8 event stream", bytes };
  }
}

export function decodeMcpHttp(bytes: Uint8Array, contentType: string): Decode<RpcMessage>[] {
  if (!contentType.toLowerCase().includes("text/event-stream")) return [decodeMcp(bytes)];
  const decoded = decodeSse(bytes);
  if (!decoded.ok) return [decoded];
  return decoded.value.filter(event => event.data !== "").map(event => {
    const message = decodeMcp(new TextEncoder().encode(event.data));
    return message.ok ? message : { ok: false, why: message.why, bytes };
  });
}
