import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// An MCP server that stands in for one of the session's MCP servers. It lists the tools the session recorded
// for that server and sends every call to Phoenix.

const server = process.argv[2];
const tools = JSON.parse(readFileSync(process.env.PHOENIX_CC_LOADOUT, "utf8")).mcp[server] ?? [];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

async function call(id, params) {
  const response = await fetch(process.env.PHOENIX_TOOLS_URL + "/" + encodeURIComponent(server), {
    method: "POST",
    headers: { "content-type": "application/json", "x-phoenix-tool-call": String(id) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: params.name, arguments: params.arguments ?? {} } }),
  });
  const reply = await response.json();
  appendFileSync(join(process.env.PHOENIX_CC_ANSWERS, "calls.jsonl"), JSON.stringify({ server, name: params.name, how: reply.error ? "stopped" : "recorded" }) + "\n");
  if (reply.error) return { content: [{ type: "text", text: "Phoenix stopped this replay: " + reply.error.message }], isError: true };
  return reply.result;
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "phoenix" } } });
  else if (method === "tools/list") send({ id, result: { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema, ...(tool.always ? { _meta: { "anthropic/alwaysLoad": true } } : {}) })) } });
  else if (method === "tools/call") send({ id, result: await call(id, params) });
  else if (method === "ping") send({ id, result: {} });
  else send({ id, error: { code: -32601, message: "Method not found: " + method } });
}
