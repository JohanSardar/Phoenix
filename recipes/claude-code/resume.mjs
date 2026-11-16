import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { NATIVE, mendSchema } from "./tools.mjs";

const moment = JSON.parse(readFileSync("/phoenix/moment/moment.json", "utf8"));
const loadout = JSON.parse(readFileSync("/phoenix/moment/loadout.json", "utf8"));
const { box } = moment;
const home = "/phoenix/agent";
const answers = join(home, "answers");
const project = join(home, ".claude", "projects", box.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
for (const dir of [project, answers]) mkdirSync(dir, { recursive: true });
renameSync(join(home, "credentials.json"), join(home, ".claude", ".credentials.json"));
writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
const cut = readFileSync("/phoenix/moment/cut.jsonl", "utf8").split("\n").map(line => {
  if (!line.includes('"prompt_snapshot"')) return line;
  const entry = JSON.parse(line);
  const snapshot = entry.attachment;
  if (snapshot?.type !== "prompt_snapshot") return line;
  if (snapshot.tools) snapshot.tools = snapshot.tools.map(tool => ({ ...tool, schema: mendSchema(tool.schema) }));
  if (snapshot.systemPrompt && existsSync("/worktree/SYSTEM.md")) snapshot.systemPrompt = [readFileSync("/worktree/SYSTEM.md", "utf8")];
  if (snapshot.systemPrompt && existsSync("/worktree/APPEND_SYSTEM.md")) snapshot.systemPrompt = [...snapshot.systemPrompt, readFileSync("/worktree/APPEND_SYSTEM.md", "utf8")];
  return JSON.stringify(entry);
}).join("\n");
writeFileSync(join(project, box.session + ".jsonl"), cut);
writeFileSync(join(home, "placeholder.txt"), "");

const since = new Date(box.started ?? 0);
for (const file of loadout.world) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content);
  utimesSync(file.path, since, since);
}
const own = new Set(["phoenix.harness.yaml", "SYSTEM.md", "APPEND_SYSTEM.md"]);
mkdirSync(box.cwd, { recursive: true });
cpSync("/worktree", box.cwd, { recursive: true, filter: path => !own.has(relative("/worktree", path)) });

const env = { PHOENIX_TOOLS_URL: process.env.PHOENIX_TOOLS_URL, PHOENIX_CC_LOADOUT: "/phoenix/moment/loadout.json", PHOENIX_CC_ANSWERS: answers };
writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Object.keys(loadout.mcp).map(server => [server, { type: "stdio", command: "node", args: ["/phoenix/recipe/mcp.mjs", server], env }])) }));
const hook = phase => [{ matcher: "*", hooks: [{ type: "command", command: "node /phoenix/recipe/stand-in.mjs " + phase }] }];
writeFileSync(join(home, "settings.json"), JSON.stringify({ hooks: { PreToolUse: hook("pre"), PostToolUse: hook("post") } }));
writeFileSync(join(home, "system.md"), existsSync("/worktree/SYSTEM.md") ? readFileSync("/worktree/SYSTEM.md", "utf8") : loadout.system.join("\n\n"));

let configured = {};
try { configured = JSON.parse(readFileSync(join(box.cwd, ".claude", "settings.json"), "utf8")); } catch {}
const model = configured.model ?? moment.model.id;
const args = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--resume", box.session, "--fork-session",
  "--settings", join(home, "settings.json"), "--mcp-config", join(home, "mcp.json"), "--strict-mcp-config",
  "--system-prompt-file", join(home, "system.md"),
  ...(existsSync("/worktree/APPEND_SYSTEM.md") ? ["--append-system-prompt-file", "/worktree/APPEND_SYSTEM.md"] : []),
  "--permission-mode", "bypassPermissions",
  "--model", model,
  ...(box.effort && !configured.effortLevel ? ["--effort", box.effort] : []),
];
const { LD_PRELOAD: _, ...inherited } = process.env;
const started = Date.now();
const child = spawn("claude", args, {
  cwd: box.cwd, stdio: ["pipe", "pipe", "inherit"],
  env: { ...inherited, ...env, HOME: home, IS_SANDBOX: "1", CLAUDE_CODE_ENTRYPOINT: box.entrypoint ?? "sdk-cli", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
});
child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: moment.prompt } }) + "\n");
const stream = [];
let pending = "";
child.stdout.on("data", chunk => { pending += chunk; const parts = pending.split("\n"); pending = parts.pop(); stream.push(...parts.filter(Boolean)); });
const code = await new Promise(resolve => child.once("close", code => resolve(code ?? 1)));
if (pending.trim()) stream.push(pending);
writeFileSync("/phoenix/out/claude.jsonl", stream.join("\n") + "\n");

const forked = readdirSync(project).filter(name => name.endsWith(".jsonl") && name !== box.session + ".jsonl").map(name => join(project, name))[0];
const kept = new Set(cut.split("\n").filter(Boolean).map(line => JSON.parse(line).uuid).filter(Boolean));
const added = [];
if (forked) for (const line of readFileSync(forked, "utf8").split("\n").filter(Boolean)) {
  const entry = JSON.parse(line);
  if (added.length || (entry.uuid && !kept.has(entry.uuid) && Date.parse(entry.timestamp) >= started - 60000)) added.push(line);
}
writeFileSync("/phoenix/out/session.jsonl", cut + added.map(line => line + "\n").join(""));
const messages = stream.map(line => { try { return JSON.parse(line); } catch { return {}; } });
const final_text = messages.findLast(message => message.type === "result")?.result ?? "";
const seen = new Set(readFileSync(join(answers, "calls.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).map(line => JSON.parse(line).id).filter(Boolean));
const calls = added.map(line => JSON.parse(line)).filter(entry => entry.type === "assistant").flatMap(entry => entry.message?.content ?? []).filter(block => block.type === "tool_use" && !NATIVE.includes(block.name));
const unseen = calls.filter(block => !block.name.startsWith("mcp__") && !seen.has(block.id)).map(block => block.name);
const shape = added.map(line => JSON.parse(line)).find(entry => entry.type === "api-request-shape")?.shape;
const names = shape ? shape.tools.map(tool => tool.name) : [];
const context = shape ? { tools_missing: loadout.tools.filter(name => !names.includes(name)), tools_added: names.filter(name => !loadout.tools.includes(name)) } : null;
writeFileSync("/phoenix/out/result.json", JSON.stringify({ session: "session.jsonl", final_text, code, llm: model, calls_phoenix_never_saw: unseen, context }) + "\n");
if (unseen.length) process.stderr.write("Claude Code answered these calls itself, before Phoenix saw them: " + unseen.join(", ") + "\n");
process.exitCode = code;
