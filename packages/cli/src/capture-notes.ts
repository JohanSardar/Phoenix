import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { note } from "@phoenix/capture";

export async function flagCommand(args: string[]) {
  try { await note({ kind: "mark", text: args.join(" ") }); } catch {}
}
export async function taskCommand(args: string[]) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { cwd: { type: "string" } } });
    if (!["start", "end"].includes(positionals[0]!) || !positionals[1]) return;
    await note({ kind: "task", op: positionals[0], task: positionals[1], cwd: values.cwd, text: "" });
  } catch {}
}
export async function correctionCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { at: { type: "string" }, "one-off": { type: "boolean" } } });
  if (!positionals[0] || !positionals[1] || !values.at) throw new Error("Usage: phoenix correct <capture-directory> --at <event> <text> [--one-off]");
  await note({ kind: "correction", root: positionals[0], at: values.at, text: positionals.slice(1).join(" "), oneOff: values["one-off"] });
}
export async function flagServer() {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const request = JSON.parse(line) as { id?: string | number; method: string; params?: { name?: string; arguments?: { reason?: string } } };
      if (request.id === undefined) continue;
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "phoenix-flag", version: "1" } };
      else if (request.method === "tools/list") result = { tools: [{ name: "flag", description: "Mark a mistake in the current run", inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } }] };
      else if (request.method === "tools/call" && request.params?.name === "flag" && typeof request.params.arguments?.reason === "string") { await flagCommand([request.params.arguments.reason]); result = { content: [{ type: "text", text: "Marked" }] }; }
      else if (request.method === "ping") result = {};
      else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\n"); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    } catch {}
  }
}
