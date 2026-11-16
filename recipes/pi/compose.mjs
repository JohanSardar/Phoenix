// Writes a pi v3 session file for a made-up moment: one that never happened live.
// Reads the made-up moment as JSON on stdin and prints the session on stdout. Its last line is the prompt, at the moment's time.
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

const made = JSON.parse(await text(process.stdin));
const time = Date.parse(made.time);
if (!Number.isFinite(time)) throw new Error("The made-up moment needs a time");
const entries = [];
const message = body => entries.push({ type: "message", message: body });
const said = value => typeof value === "string" ? value : JSON.stringify(value);

entries.push({ type: "model_change", provider: made.llm.provider, modelId: made.llm.id });
if (made.llm.thinking) entries.push({ type: "thinking_level_change", thinkingLevel: made.llm.thinking });
message({ role: "system", content: "", sections: {}, toolsAdded: made.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, phoenix: { connector: tool.connector, op: tool.op } })) });
for (const turn of [...made.messages, { role: "user", text: made.prompt }]) {
  if (turn.role === "user") { message({ role: "user", content: [{ type: "text", text: turn.text }] }); continue; }
  const calls = (turn.calls ?? []).map(call => ({ ...call, id: `call_${randomUUID().replaceAll("-", "").slice(0, 16)}` }));
  message({
    role: "assistant", api: "phoenix-made-up", provider: made.llm.provider, model: made.llm.id,
    content: [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...calls.map(call => ({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args ?? {} }))],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: calls.length ? "toolUse" : "stop",
  });
  for (const call of calls) message({ role: "toolResult", toolCallId: call.id, toolName: call.tool, content: [{ type: "text", text: said(call.answer) }], details: {}, isError: !!call.error });
}

let parentId = null;
const lines = [{ type: "session", version: 3, id: randomUUID(), timestamp: new Date(time - entries.length * 1000).toISOString(), cwd: made.cwd }];
entries.forEach((entry, index) => {
  const at = time - (entries.length - 1 - index) * 1000;
  const id = randomUUID().slice(0, 8);
  lines.push({ ...entry, id, parentId, timestamp: new Date(at).toISOString(), ...(entry.message ? { message: { ...entry.message, timestamp: at } } : {}) });
  parentId = id;
});
process.stdout.write(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
