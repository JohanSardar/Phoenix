// Loaded with --import into Supabase's own MCP server. It decides where the server's HTTP requests go.
// copy: every request goes to the working copy on this box's loopback, never to Supabase.
// snapshot: reads go to the real Supabase and are written down. SQL is sent with read_only set, so Supabase runs it
// in a read-only transaction. Every other write is refused before it leaves this machine.
import { appendFileSync } from "node:fs";

const mode = process.env.PHOENIX_SUPABASE_MODE;
const log = line => appendFileSync(process.env.PHOENIX_SUPABASE_LOG, JSON.stringify(line) + "\n");
const audit = line => { if (process.env.PHOENIX_SUPABASE_AUDIT) appendFileSync(process.env.PHOENIX_SUPABASE_AUDIT, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n"); };
const READS = [/^\/v1\/projects\/[^/]+\/database\/query$/, /^\/v2\/projects\/[^/]+\/advisors\/run$/];
const TEXT = /^(application\/(json|.*\+json)|text\/)/;

if (process.argv.slice(1).some(arg => arg.includes("mcp-server-supabase")) && (mode === "copy" || mode === "snapshot")) {
  const send = globalThis.fetch;
  if (mode === "snapshot") {
    const flag = name => process.argv.find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
    const value = name => flag(name)?.split("=").slice(1).join("=");
    log({ server: { read_only: !!flag("read-only"), project_ref: value("project-ref"), features: value("features") } });
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const docs = url.hostname === "supabase.com" && url.pathname === "/docs/api/graphql";
    if (url.hostname !== "api.supabase.com" && !docs) throw new Error(`Phoenix keeps the Supabase server away from ${url.hostname}`);
    let body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
    if (mode === "copy") {
      return send(new URL(url.pathname + url.search, process.env.PHOENIX_SUPABASE_COPY), { method: request.method, body, headers: { "content-type": "application/json", "x-phoenix-host": url.host } });
    }
    const read = request.method === "GET" || docs || (request.method === "POST" && READS.some(pattern => pattern.test(url.pathname)));
    const path = url.pathname.replace(/^\/(v[12])\/projects\/[^/]+/, "/$1/projects/{ref}");
    if (!read) {
      audit({ refused: request.method, path });
      log({ refused: request.method, url: url.toString() });
      return new Response(JSON.stringify({ message: `Phoenix takes a read-only snapshot and did not send this ${request.method}` }), { status: 403, headers: { "content-type": "application/json" } });
    }
    if (/\/database\/query$/.test(url.pathname)) body = JSON.stringify({ ...JSON.parse(body), read_only: true });
    audit({ method: request.method, path, ...(/\/database\/query$/.test(url.pathname) ? { sql: "sent read-only" } : {}) });
    const response = await send(url, { method: request.method, headers: request.headers, body });
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    log({
      method: request.method, url: url.toString(), ...(body !== undefined ? { request: body } : {}), status: response.status,
      headers: [...response.headers].filter(([name]) => ["content-type", "content-disposition"].includes(name)),
      ...(TEXT.test(type) ? { body: bytes.toString("utf8") } : { body_base64: bytes.toString("base64") }),
    });
    return response;
  };
}
