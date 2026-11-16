import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

function expand(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key, fallback) => {
    const found = process.env[key] || fallback;
    if (found === undefined) throw new Error("Missing MCP environment variable");
    return found;
  });
}
async function config(path, optional = false) {
  let source;
  try { source = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (optional && error.code === "ENOENT") return []; throw error; }
  return Object.entries(source.mcpServers ?? source.mcp).filter(([, server]) => server.enabled !== false && (server.command || !server.oauth && process.env.PHOENIX_FX_HTTP_STDIO === "1")).map(([name, server]) => {
    if (server.command) {
      const command = Array.isArray(server.command) ? server.command : [server.command, ...server.args ?? []];
      return { name, command: expand(command[0]), args: command.slice(1).map(expand), env: Object.entries(server.environment ?? server.env ?? {}).map(([name, value]) => ({ name, value: expand(value) })) };
    }
    if (!server.url) throw new Error("Unsupported MCP entry");
    const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value: expand(value) }));
    for (const [name, variable] of Object.entries(server.header_env ?? {})) {
      const value = process.env[variable];
      if (!value) throw new Error("Missing MCP header environment variable");
      headers.push({ name, value });
    }
    if (server.bearer_token_env) {
      const token = process.env[server.bearer_token_env];
      if (!token) throw new Error("Missing MCP bearer environment variable");
      headers.push({ name: "Authorization", value: `Bearer ${token}` });
    }
    return { name, type: server.type ?? "http", url: expand(server.url), headers };
  });
}
try {
  const args = process.argv.slice(2), split = args.indexOf("--"), own = split < 0 ? args : args.slice(0, split), fxArgs = split < 0 ? [] : args.slice(split + 1);
  if (own.length && (own.length !== 2 || own[0] !== "--mcp-config")) throw new Error("Expected --mcp-config path");
  const configured = own.length ? await config(resolve(own[1])) : [];
  const child = spawn("fx", ["acp", ...fxArgs], { stdio: ["pipe", "inherit", "inherit"] });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on("error", () => { process.stderr.write("Could not start fx ACP\n"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.stdin.destroy(); for (const [name, handler] of handlers) process.off(name, handler); if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const message = JSON.parse(line);
      if (["session/new", "session/load", "session/resume"].includes(message.method)) {
        const params = message.params ??= {};
        let servers = [...params.mcpServers ?? []];
        if (params._meta?.fx?.profileMcpServers) {
          servers.push(...(await config(join(process.env.PHOENIX_FX_SOURCE_HOME ?? homedir(), ".fx", "mcp.json"), true)).filter(server => !servers.some(existing => existing.name === server.name)));
        }
        servers.push(...configured.filter(server => !servers.some(existing => existing.name === server.name)));
        params.mcpServers = servers.map(server => {
          if (process.env.PHOENIX_FX_MCP_PROXY !== "true") return server;
          if (server.type === "http" && process.env.PHOENIX_FX_HTTP_STDIO === "1") {
            server = { name: server.name, command: process.execPath, args: [fileURLToPath(new URL("./http-stdio.mjs", import.meta.url)), server.url], env: [{ name: "PHOENIX_FX_HTTP_HEADERS", value: JSON.stringify(server.headers ?? []) }] };
          }
          if (server.type) return server;
          if (!process.env.PHOENIX_CAPTURE) throw new Error("Run inside phoenix capture");
          const routing = ["PATH", "PHOENIX_CAPTURE", "PHOENIX_COLLECTOR", "PHOENIX_HOME", "PHOENIX_CWD", "PHOENIX_COPY_IGNORED"].filter(name => process.env[name] !== undefined).map(name => ({ name, value: process.env[name] }));
          return { ...server, command: resolve(process.env.PATH.split(":")[0], "phoenix"), args: ["mcp-proxy", server.name, "--", server.command, ...server.args], env: [...server.env ?? [], ...routing] };
        });
      }
      if (!child.stdin.write(JSON.stringify(message) + "\n")) await new Promise(resolve => child.stdin.once("drain", resolve));
    } catch {
      child.kill("SIGTERM");
      process.stderr.write("fx routing failed; no MCP payload or credential is logged\n");
      process.exitCode = 1;
      break;
    }
  }
  child.stdin.end();
} catch {
  process.stderr.write("Could not configure fx capture; no config content is logged\n");
  process.exitCode = 1;
}
