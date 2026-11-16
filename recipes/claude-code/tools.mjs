// Which Claude Code tools Phoenix answers, and how a call is named and keyed for its stand-in.
// Built-in tools that only change Claude Code's own state run inside Claude Code in the box.

export const CONNECTOR = "claude-code";
export const NATIVE = ["ToolSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "EnterPlanMode", "ExitPlanMode", "ListAgents"];
export const READ_ONLY = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"];

const hidden = /^\[secret:[0-9a-f]{64}\]$/;
export function mendSchema(schema) {
  if (Array.isArray(schema)) return schema.map(mendSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "properties" && value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, typeof inner === "string" && hidden.test(inner) ? {} : mendSchema(inner)])) : mendSchema(value)]));
}

export const mcpName = name => /^mcp__(.+?)__(.+)$/.exec(name);

export function route(name) {
  const mcp = mcpName(name);
  return mcp ? { connector: mcp[1], op: mcp[2] } : { connector: CONNECTOR, op: name };
}

export function callArgs(name, input) {
  if (name !== "Bash") return input ?? {};
  return { command: input?.command, ...(input?.run_in_background ? { run_in_background: true } : {}) };
}
