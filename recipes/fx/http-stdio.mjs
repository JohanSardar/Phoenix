import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const endpoint = process.argv[2], headers = Object.fromEntries(JSON.parse(process.env.PHOENIX_FX_HTTP_HEADERS ?? "[]").map(({ name, value }) => [name, value]));
const abort = new AbortController();
let session, protocol, listening;
function deliver(text) {
  const message = JSON.parse(text);
  if (message.result?.protocolVersion) protocol = message.result.protocolVersion;
  process.stdout.write(JSON.stringify(message) + "\n");
  return message;
}
async function output(response, id) {
  if (!response.ok) throw new Error("MCP HTTP transport failed");
  if (response.status === 202 || response.status === 204) return;
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = await response.text();
    if (body.trim()) deliver(body);
    return;
  }
  const stream = Readable.fromWeb(response.body);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let data = [];
  try {
    for await (const line of lines) {
      if (!line) {
        if (data.length) {
          const message = deliver(data.join("\n"));
          if (id !== undefined && message.id === id && ("result" in message || "error" in message)) return;
        }
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) deliver(data.join("\n"));
  } finally {
    lines.close();
    stream.destroy();
  }
}
function requestHeaders() {
  return { ...headers, accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...(protocol ? { "mcp-protocol-version": protocol } : {}) };
}
async function send(line) {
  const message = JSON.parse(line);
  const version = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const response = await fetch(endpoint, { method: "POST", headers: { ...requestHeaders(), "content-type": "application/json", ...(version ? { "mcp-protocol-version": version, "mcp-method": message.method, ...(message.params?.name ? { "mcp-name": message.params.name } : {}) } : {}) }, body: line, signal: abort.signal, redirect: "error" });
  session = response.headers.get("mcp-session-id") ?? session;
  if (message.method === "initialize") protocol = message.params?.protocolVersion;
  await output(response, message.id);
  if (message.method === "notifications/initialized" && !listening) {
    listening = fetch(endpoint, { headers: requestHeaders(), signal: abort.signal, redirect: "error" }).then(response => response.status === 405 ? undefined : output(response)).catch(() => { if (!abort.signal.aborted) fail(); });
  }
}
function fail() {
  process.stderr.write("MCP HTTP bridge failed; no payload is logged\n");
  process.exitCode = 1;
  abort.abort();
  process.stdin.destroy();
}
try {
  const pending = new Set();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const promise = send(line).catch(fail).finally(() => pending.delete(promise));
    pending.add(promise);
    if (JSON.parse(line).method === "initialize") await promise;
  }
  await Promise.all(pending);
} catch {
  process.stderr.write("MCP HTTP bridge failed; no payload is logged\n");
  process.exitCode = 1;
} finally {
  abort.abort();
  if (session) await fetch(endpoint, { method: "DELETE", headers: requestHeaders(), signal: AbortSignal.timeout(2000), redirect: "error" }).catch(() => {});
}
