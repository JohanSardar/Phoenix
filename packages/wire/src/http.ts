import { decodeJson, encodeJson, object } from "./json.ts";

export type Headers = readonly string[];
export interface HttpRequest {
  method: string;
  url: string;
  headers: Headers;
  httpVersion: string;
}
export interface HttpResponse {
  status: number;
  statusMessage?: string;
  headers: Headers;
}
export interface HttpExchange {
  request: HttpRequest & { body: Uint8Array; trailers?: Headers };
  response?: HttpResponse & { body: Uint8Array; trailers?: Headers };
  aborted: boolean;
}
export const HTTP_STREAM = { requestBody: 0, responseHead: 1, responseBody: 2, requestTrailers: 3, responseTrailers: 4 } as const;
export const encodeHttpHead = (head: HttpResponse): Uint8Array => encodeJson(head);

export function decodeHttpHead(bytes: Uint8Array): HttpResponse {
  const decoded = decodeJson(bytes);
  const value = object(decoded.ok ? decoded.value : undefined);
  if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 999 || !Array.isArray(value.headers) || value.headers.length % 2 !== 0 || !value.headers.every(h => typeof h === "string"))
    throw new TypeError("Invalid HTTP response head from Backend");
  return value as unknown as HttpResponse;
}

export function header(headers: Headers, name: string): string | undefined {
  for (let i = 0; i < headers.length; i += 2) if (headers[i]!.toLowerCase() === name.toLowerCase()) return headers[i + 1];
  return undefined;
}
