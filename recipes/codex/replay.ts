import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const task = process.argv[2], model = process.env.CODEX_MODEL, endpoint = process.env.PHOENIX_CODEX_MODEL_URL;
if (!task || !model || !endpoint) throw new Error("Replay needs task file, CODEX_MODEL and PHOENIX_CODEX_MODEL_URL");
const mcp = JSON.parse(await readFile(process.env.CODEX_REPLAY_MCP ?? ".phoenix-mcp.json", "utf8"));
const home = await mkdtemp(join(tmpdir(), "phoenix-codex-"));
const config = [
  `model=${JSON.stringify(model)}`,
  `model_reasoning_effort=${JSON.stringify(process.env.CODEX_REASONING_EFFORT ?? "low")}`,
  'model_provider="phoenix_replay"',
  'shell_environment_policy={inherit="all"}',
  '[model_providers.phoenix_replay]',
  'name="Phoenix replay"',
  `base_url=${JSON.stringify(endpoint)}`,
  'wire_api="responses"',
  'supports_websockets=false',
  'env_key="PHOENIX_REPLAY_TOKEN"',
];
for (const [name, value] of Object.entries(mcp.mcpServers) as [string, { command?: string; args?: string[]; url?: string }][]) {
  config.push(`[mcp_servers.${JSON.stringify(name)}]`);
  if (value.command) config.push(`command=${JSON.stringify(value.command)}`, `args=${JSON.stringify(value.args ?? [])}`);
  else if (value.url) config.push(`url=${JSON.stringify(value.url)}`);
}
try {
  await writeFile(join(home, "config.toml"), config.join("\n"), { mode: 0o600 });
  const child = spawn("codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", await readFile(task, "utf8")], { env: { ...process.env, CODEX_HOME: home, PHOENIX_REPLAY_TOKEN: "phoenix-placeholder" }, stdio: "inherit" });
  const forwards = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = forwards.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return handler; });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => { child.once("error", fail); child.once("exit", (code, signal) => done({ code, signal })); });
    if (result.signal) { forwards.forEach((signal, i) => process.off(signal, handlers[i]!)); process.kill(process.pid, result.signal); }
    else process.exitCode = result.code ?? 1;
  } finally { forwards.forEach((signal, i) => process.off(signal, handlers[i]!)); }
} finally { await rm(home, { recursive: true, force: true }); }
