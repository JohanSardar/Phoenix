import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { at: { type: "string" } } });
const at = Number(values.at);
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
if (!Number.isInteger(at) || at < 1 || at > lines.length) throw new Error(`--at must be a line of the session (1-${lines.length})`);
const entries = lines.map((line, index) => ({ line: index + 1, entry: JSON.parse(line) }));
if (entries[0]?.entry.type !== "session" || entries[0].entry.version !== 3) throw new Error("Only pi session format v3 is supported");
const isUser = ({ entry }) => entry.type === "message" && entry.message.role === "user";
const turn = entries.slice(0, at).findLast(isUser);
if (!turn) throw new Error(`No user message at or before line ${at}; a moment starts at the user turn that holds it`);
const content = turn.entry.message.content;
if (Array.isArray(content) && content.some(block => block.type !== "text")) throw new Error("The user turn holds images or files; only text turns can be resumed");
const prompt = typeof content === "string" ? content : content.map(block => block.text).join("");

const before = entries.slice(0, turn.line - 1);
let sections = {};
const tools = new Map();
let provider, model, thinking;
const system = message => {
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (value === null) delete sections[name];
    else sections[name] = value;
  }
  for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
};
for (const { entry } of before) {
  if (entry.type === "model_change") { provider = entry.provider; model = entry.modelId; }
  if (entry.type === "thinking_level_change") thinking = entry.thinkingLevel;
  if (entry.type === "compaction" && entry.systemMessage) { sections = {}; tools.clear(); system(entry.systemMessage); }
  if (entry.type === "message" && entry.message.role === "system") system(entry.message);
  if (entry.type === "message" && entry.message.role === "assistant" && entry.message.provider) { provider = entry.message.provider; model = entry.message.model; }
}
if (!provider || !model) throw new Error("The session names no provider and model before this moment");

const calls = new Map();
const servers = new Map();
for (const { entry } of entries) {
  if (entry.type !== "message") continue;
  if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) for (const block of entry.message.content) if (block.type === "toolCall") calls.set(block.id, block);
  if (entry.message.role === "toolResult" && entry.message.details?.server && entry.message.details?.tool) servers.set(entry.message.toolName, entry.message.details);
}
const route = name => {
  const mcp = servers.get(name) ?? (/^mcp__(.+?)__(.+)$/.exec(name) ? { server: /^mcp__(.+?)__(.+)$/.exec(name)[1], tool: /^mcp__(.+?)__(.+)$/.exec(name)[2] } : undefined);
  return mcp ? { connector: mcp.server, op: mcp.tool } : { connector: "pi", op: name };
};
const answers = [];
for (const { line, entry } of entries) {
  if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
  const call = calls.get(entry.message.toolCallId);
  if (!call) continue;
  const { content, details, isError } = entry.message;
  answers.push({ id: entry.message.toolCallId, line, tool: entry.message.toolName, ...route(entry.message.toolName), args: call.arguments ?? {}, result: { content, isError: !!isError, ...(details ? { details } : {}) }, observed_at: entry.timestamp, before_cut: line < turn.line });
}

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at, turn: turn.line, cut_lines: turn.line - 1, prompt, time: turn.entry.timestamp, cwd: entries[0].entry.cwd,
  model: { provider, id: model, ...(thinking ? { thinking } : {}) },
  loadout: { sections, harness_sections: ["addendum"], tools: [...tools.values()].map(tool => ({ ...tool, ...route(tool.name) })) },
  answers,
  read_only: { pi: ["read", "grep", "find", "ls"] },
}) + "\n");
