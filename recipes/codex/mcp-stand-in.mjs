// A stdio MCP server that offers one server's tools as the session saw them. Phoenix answers each call.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const server = process.argv[2];
const tools = JSON.parse(readFileSync(process.env.PHOENIX_CODEX_LOADOUT ?? "/phoenix/moment/loadout.json", "utf8")).mcp[server] ?? [];
const url = `${process.env.PHOENIX_TOOLS_URL ?? "http://phoenix-tools"}/${encodeURIComponent(server)}`;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "phoenix" } } });
  else if (method === "tools/list") send({ id, result: { tools } });
  else if (method === "ping") send({ id, result: {} });
  else if (method === "tools/call") {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const reply = await response.json();
    send(reply.error ? { id, result: { content: [{ type: "text", text: `Phoenix stopped this replay: ${reply.error.message}` }], isError: true } } : { id, result: reply.result });
  } else send({ id, error: { code: -32601, message: `${method} is not offered by Phoenix's stand-in` } });
}
