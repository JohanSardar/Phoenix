import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const moment = JSON.parse(readFileSync("/phoenix/moment/moment.json", "utf8"));
const loadout = JSON.parse(readFileSync("/phoenix/moment/loadout.json", "utf8"));
const home = "/phoenix/agent";
const cut = readFileSync("/phoenix/moment/cut.jsonl", "utf8").split("\n").filter(Boolean);
const closed = cut.findLastIndex(line => ["task_complete", "turn_aborted"].includes(JSON.parse(line).payload?.type));
const session = [...cut.slice(0, closed + 1), ...cut.slice(closed + 1).filter(line => JSON.parse(line).type !== "event_msg")];
const day = loadout.started.slice(0, 10).replaceAll("-", "/");
const own = `rollout-${loadout.started.slice(0, 19).replaceAll(":", "-")}-${loadout.session}.jsonl`;
mkdirSync(join("/phoenix/out/sessions", day), { recursive: true });
symlinkSync("/phoenix/out/sessions", join(home, "sessions"));
writeFileSync(join(home, "sessions", day, own), session.join("\n") + "\n");

for (const directory of [loadout.cwd, ...loadout.directories]) mkdirSync(directory, { recursive: true });
if (loadout.agents.project) writeFileSync(join(loadout.agents.directory ?? loadout.cwd, "AGENTS.md"), loadout.agents.project);
const addendum = existsSync("/worktree/AGENTS.md") ? readFileSync("/worktree/AGENTS.md", "utf8").trim() : "";
const global = [loadout.agents.global, addendum].filter(Boolean).join("\n\n");
if (global) writeFileSync(join(home, "AGENTS.md"), global);
if (loadout.timezone && existsSync(`/usr/share/zoneinfo/${loadout.timezone}`)) { rmSync("/etc/localtime", { force: true }); symlinkSync(`/usr/share/zoneinfo/${loadout.timezone}`, "/etc/localtime"); }

const { settings } = loadout;
const quote = JSON.stringify;
const config = [
  `model_provider = ${quote(settings.provider)}`, `model = ${quote(settings.model)}`,
  ...[["model_reasoning_effort", settings.effort], ["model_reasoning_summary", settings.summary], ["personality", settings.personality], ["service_tier", settings.service_tier]].filter(([, value]) => value).map(([key, value]) => `${key} = ${quote(value)}`),
  ...(existsSync("/worktree/models.json") ? ['model_catalog_json = "/worktree/models.json"'] : []),
  'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', 'web_search = "disabled"',
  `[model_providers.${quote(settings.provider)}]`, 'name = "ChatGPT Codex backend"', 'base_url = "https://chatgpt.com/backend-api/codex"', 'wire_api = "responses"', "requires_openai_auth = true", "supports_websockets = false",
  "[features]", "apps = false", "plugins = false", "remote_plugin = false", "shell_snapshot = false", "hooks = false", "memories = false",
  ...Object.keys(loadout.mcp).flatMap(server => [`[mcp_servers.${quote(server)}]`, 'command = "node"', `args = ${quote(["/phoenix/recipe/mcp-stand-in.mjs", server])}`, `env = { PHOENIX_TOOLS_URL = ${quote(process.env.PHOENIX_TOOLS_URL)} }`]),
];
writeFileSync(join(home, "config.toml"), config.join("\n") + "\n");
const profile = existsSync("/worktree/config.toml");
if (profile) writeFileSync(join(home, "harness.config.toml"), readFileSync("/worktree/config.toml"));

const { LD_PRELOAD: _, ...env } = process.env;
const child = spawn("codex", ["exec", ...(profile ? ["-p", "harness"] : []), "fork", loadout.session, "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"], {
  cwd: loadout.cwd, stdio: ["pipe", "inherit", "inherit"], env: { ...env, CODEX_HOME: home, SHELL: "/bin/zsh", PHOENIX_CODEX_SHELL: "1" },
});
child.stdin.end(moment.prompt);
const code = await new Promise(resolve => child.once("close", code => resolve(code ?? 1)));
const forked = readdirSync(join(home, "sessions"), { recursive: true }).find(name => name.endsWith(".jsonl") && !name.endsWith(own));
const resumed = forked ? readFileSync(join(home, "sessions", forked), "utf8").split("\n").filter(Boolean) : [];
writeFileSync("/phoenix/out/resumed.jsonl", [...cut, ...resumed].join("\n") + "\n");
const rows = resumed.map(line => JSON.parse(line));
const done = rows.findLast(row => row.payload?.type === "task_complete");
const said = rows.findLast(row => row.type === "response_item" && row.payload?.type === "message" && row.payload.role === "assistant");
const text = done?.payload.last_agent_message ?? said?.payload.content?.filter(part => part.type === "output_text").map(part => part.text).join("") ?? "";
writeFileSync("/phoenix/out/result.json", JSON.stringify({ session: "resumed.jsonl", final_text: text, code }) + "\n");
process.exitCode = code;
