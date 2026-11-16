// Loaded with --import into Sentry's MCP server. It decides where the server's Sentry API calls go.
// copy: every call goes to the working copy on this machine's loopback, never to Sentry.
// snapshot: GET goes to the real Sentry and is written down; any other method is refused and never sent.
import { appendFileSync } from "node:fs";

const send = globalThis.fetch;
const mode = process.env.PHOENIX_SENTRY_MODE;
const isSentry = host => host === "sentry.io" || host.endsWith(".sentry.io");

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!isSentry(url.hostname)) throw new Error(`Phoenix keeps the Sentry server away from ${url.hostname}`);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  if (mode === "copy") return send(new URL(url.pathname + url.search, process.env.PHOENIX_SENTRY_COPY), { method: request.method, body, headers: { "content-type": "application/json", "x-phoenix-host": url.host } });
  if (mode !== "snapshot") throw new Error("PHOENIX_SENTRY_MODE must be copy or snapshot");
  if (request.method !== "GET") {
    appendFileSync(process.env.PHOENIX_SENTRY_LOG, JSON.stringify({ refused: request.method, url: url.toString() }) + "\n");
    return new Response(JSON.stringify({ detail: `Phoenix takes a read-only snapshot and did not send this ${request.method}` }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const response = await send(request);
  const text = await response.clone().text();
  const headers = [...response.headers].filter(([name]) => ["content-type", "link", "x-hits", "x-max-hits"].includes(name));
  appendFileSync(process.env.PHOENIX_SENTRY_LOG, JSON.stringify({ method: "GET", url: url.toString(), status: response.status, headers, body: text }) + "\n");
  return response;
};
