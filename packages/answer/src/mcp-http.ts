import { decodeJson, decodeSse, header, type HttpRequest } from "@phoenix/wire";
import { mcpShape } from "./normalize.ts";

export function mcpHttpShape(request: HttpRequest, body: Uint8Array): { op: string; args: unknown; transport: Record<string, string> } {
  const shape = mcpShape(body);
  const transport = Object.fromEntries(["mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "last-event-id"].flatMap(name => {
    const value = header(request.headers, name);
    return value === undefined ? [] : [[name, value]];
  }));
  if (request.method === "POST" && shape?.message.method) return { op: shape.op!, args: shape.op!.startsWith("tools/call:") ? shape.args : { params: shape.args, transport }, transport };
  if (request.method === "POST" && shape) return {
    op: "http:reply", args: { id: shape.message.id, result: shape.message.result ?? null, error: shape.message.error ?? null, transport }, transport,
  };
  const decoded = decodeJson(body);
  return { op: `http:${request.method}`, args: { transport, body: body.length ? decoded.ok ? decoded.value : Buffer.from(body).toString("base64") : null }, transport };
}

export function mcpHttpMessages(body: Uint8Array, contentType: string): { bytes: Uint8Array; offset: number }[] {
  if (!contentType.toLowerCase().includes("text/event-stream")) return [{ bytes: body, offset: 0 }];
  const text = new TextDecoder().decode(body);
  const decoded = decodeSse(body);
  if (!decoded.ok) throw new Error(decoded.why);
  const parts = text.match(/[^]*?(?:\r\n\r\n|\n\n|\r\r)/g) ?? [];
  const result: { bytes: Uint8Array; offset: number }[] = [];
  let offset = 0;
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part);
    result.push({ bytes, offset });
    offset += bytes.length;
  }
  if (offset < body.length) result.push({ bytes: body.subarray(offset), offset });
  return result;
}
