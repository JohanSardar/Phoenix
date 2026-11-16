import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR, NATIVE, callArgs } from "./tools.mjs";

// A Claude Code hook. Before a built-in tool runs, it asks Phoenix for the answer and turns the call into one
// that reproduces that answer inside the box. After the tool runs, it hands Claude Code the recorded output.

const phase = process.argv[2];
const input = JSON.parse(readFileSync(0, "utf8"));
const name = input.tool_name;
const answers = process.env.PHOENIX_CC_ANSWERS;
const slot = join(answers, encodeURIComponent(input.tool_use_id));
const say = output => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: phase === "pre" ? "PreToolUse" : "PostToolUse", ...output } }));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

if (NATIVE.includes(name) || name.startsWith("mcp__")) process.exit(0);
if (phase === "post") {
  if (existsSync(slot + ".json")) say({ updatedToolOutput: JSON.parse(readFileSync(slot + ".json", "utf8")) });
  process.exit(0);
}

const response = await fetch(process.env.PHOENIX_TOOLS_URL + "/" + CONNECTOR, {
  method: "POST",
  headers: { "content-type": "application/json", "x-phoenix-tool-call": input.tool_use_id },
  body: JSON.stringify({ jsonrpc: "2.0", id: input.tool_use_id, method: "tools/call", params: { name, arguments: callArgs(name, input.tool_input) } }),
});
const reply = await response.json();
const log = how => appendFileSync(join(answers, "calls.jsonl"), JSON.stringify({ id: input.tool_use_id, name, how }) + "\n");
if (reply.error) {
  log("stopped");
  say({ permissionDecision: "deny", permissionDecisionReason: "Phoenix stopped this replay: " + reply.error.message });
  process.exit(0);
}
const { content, is_error: failed, toolUseResult } = reply.result;
const text = typeof content === "string" ? content : (content ?? []).map(block => block.text ?? "").join("\n");
const keep = () => { if (!failed && toolUseResult !== undefined) writeFileSync(slot + ".json", JSON.stringify(toolUseResult)); };
const allow = updatedInput => say({ permissionDecision: "allow", ...(updatedInput ? { updatedInput } : {}) });
const exit = failed ? /^Exit code (\d+)\n?/.exec(text) : null;

if (name === "Bash" && (!failed || exit)) {
  const stdout = failed ? text.slice(exit[0].length) : String(toolUseResult?.stdout ?? text);
  const stderr = failed ? "" : String(toolUseResult?.stderr ?? "");
  writeFileSync(slot + ".stdout", stdout);
  writeFileSync(slot + ".stderr", stderr);
  keep();
  log("recorded");
  allow({ ...input.tool_input, command: "cat " + quote(slot + ".stdout") + "; cat " + quote(slot + ".stderr") + " >&2; exit " + (failed ? exit[1] : 0) });
} else if (name === "Read") {
  keep();
  log("recorded");
  allow(!failed && !existsSync(input.tool_input.file_path) ? { ...input.tool_input, file_path: join(process.env.HOME, "placeholder.txt") } : undefined);
} else if (["Glob", "Grep"].includes(name)) {
  keep();
  log("recorded");
  allow(failed ? undefined : { pattern: "phoenix-placeholder", path: process.env.HOME });
} else if (["Write", "Edit", "NotebookEdit"].includes(name)) {
  keep();
  log("recorded");
  allow();
} else {
  log("approximate");
  say({ permissionDecision: "deny", permissionDecisionReason: text });
}
