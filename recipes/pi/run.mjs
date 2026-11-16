import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, symlink, appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const json = async file => {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};

try {
  const capture = process.env.PHOENIX_CAPTURE;
  if (!capture) throw new Error("Run inside phoenix capture; after-the-fact capture needs only Pi and import");
  const { routes } = await json(join(capture, "capture.json"));
  const gateway = routes.includes("gateway"), mcp = routes.includes("mcp-proxy");
  const source = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
  const runtime = await mkdtemp(join(tmpdir(), "phoenix-pi-"));
  const agent = join(runtime, "agent");
  await mkdir(agent, { mode: 0o700 });
  for (const name of await readdir(source)) {
    if (!["models.json", "settings.json", "mcp.json"].includes(name)) await symlink(join(source, name), join(agent, name));
  }
  const models = await json(join(source, "models.json"));
  const settings = await json(join(source, "settings.json"));
  if (gateway) {
    const provider = option("--provider"), model = option("--model");
    if (!provider || !model || model.includes("*")) throw new Error("Gateway needs explicit --provider and exact --model, without thinking suffix");
    if (["github-copilot", "radius", "amazon-bedrock", "google-vertex"].includes(provider)) throw new Error("This provider needs transcript-only model capture");
    const baseUrl = process.env.PHOENIX_MODEL_BASE_URL;
    if (!baseUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error("Missing launcher gateway URL");
    models.providers ??= {};
    const config = models.providers[provider] ??= {};
    config.baseUrl = baseUrl;
    for (const item of config.models ?? []) item.baseUrl = baseUrl;
    settings.transport = "sse";
  }
  await writeFile(join(agent, "models.json"), JSON.stringify(models), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  const misses = [];
  const proxy = config => {
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (server.command) {
        server.args = ["mcp-proxy", name, "--", server.command, ...server.args ?? []];
        server.command = join(process.env.PATH.split(delimiter)[0], "phoenix");
      } else if (server.url) misses.push({ server: name, route: "transcript", reason: "remote URL and authorization left unchanged" });
    }
    return config;
  };
  let cwd = process.cwd();
  const adapter = option("--mcp-config");
  const globalMcp = await json(join(source, "mcp.json"));
  await writeFile(join(agent, "mcp.json"), JSON.stringify(mcp && !adapter ? proxy(globalMcp) : globalMcp), { mode: 0o600 });
  if (mcp && adapter) {
    const file = join(runtime, "mcp.json");
    await writeFile(file, JSON.stringify(proxy(JSON.parse(await readFile(resolve(adapter), "utf8")))), { mode: 0o600 });
    args[args.indexOf("--mcp-config") + 1] = file;
  } else if (mcp) {
    const project = join(cwd, ".pi");
    const config = await json(join(project, "mcp.json"));
    if (Object.keys(config).length) {
      const mirror = join(runtime, "cwd");
      await mkdir(join(mirror, ".pi"), { recursive: true, mode: 0o700 });
      for (const name of await readdir(cwd)) if (name !== ".pi") await symlink(join(cwd, name), join(mirror, name));
      for (const name of await readdir(project)) if (name !== "mcp.json") await symlink(join(project, name), join(mirror, ".pi", name));
      await writeFile(join(mirror, ".pi/mcp.json"), JSON.stringify(proxy(config)), { mode: 0o600 });
      cwd = mirror;
    }
  }
  await appendFile(join(capture, "coverage.jsonl"), JSON.stringify({ recipe: "pi", routes, model: gateway ? "models.json baseUrl; SSE" : "transcript", mcp: mcp ? "configured stdio servers" : "transcript", limitations: misses, retained_overlay: runtime, cwd_overlay: cwd !== process.cwd() }) + "\n", { mode: 0o600 });
  process.stderr.write(`Pi private config overlay: ${runtime}\n`);
  const sessionCwd = resolve(process.env.PHOENIX_CWD ?? process.cwd());
  const sessionDir = join(source, "sessions", `--${sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const child = spawn("pi", args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? sessionDir }, stdio: "inherit" });
  const signals = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, forward] of signals) process.on(signal, forward);
  child.on("error", () => { process.stderr.write("Pi could not start\n"); process.exitCode = 127; });
  child.on("exit", (code, signal) => {
    for (const [name, forward] of signals) process.off(name, forward);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write("Pi recipe configuration failed; check explicit provider/model, config paths and supported routes\n");
  process.exitCode = 1;
}
