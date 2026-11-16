// Which Claude Code tools Phoenix answers, and how a call is named and keyed for its stand-in.
// Built-in tools that only change Claude Code's own state run inside Claude Code in the box.

export const CONNECTOR = "claude-code";
export const NATIVE = ["ToolSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "EnterPlanMode", "ExitPlanMode", "ListAgents"];
export const READ_ONLY = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Skill"];

export const mcpName = name => /^mcp__(.+?)__(.+)$/.exec(name);

export function route(name) {
  const mcp = mcpName(name);
  return mcp ? { connector: mcp[1], op: mcp[2] } : { connector: CONNECTOR, op: name };
}

export function callArgs(name, input) {
  if (name !== "Bash") return input ?? {};
  return { command: input?.command, ...(input?.run_in_background ? { run_in_background: true } : {}) };
}
