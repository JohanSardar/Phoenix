import { spawn } from "node:child_process";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let temporary, signalToRaise;
try {
  const [mode, ...command] = process.argv.slice(2), url = new URL(process.env.PHOENIX_FX_MODEL_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !command.length) throw new Error("Expected a loopback gateway and command");
  const env = { ...process.env };
  if (mode === "gateway") {
    env.FX_GATEWAY_CHAT_URL = new URL("v4/ai/language-model", url.href.replace(/\/?$/, "/")).href;
  } else if (mode === "custom") {
    const settings = JSON.parse(await readFile(join(homedir(), ".fx", "settings.json"), "utf8"));
    const name = process.env.PHOENIX_FX_CONNECTION;
    if (!name || settings.provider !== name || !settings.providers?.[name]) throw new Error("Name the active custom connection");
    settings.providers[name].base_url = url.href.replace(/\/$/, "");
    temporary = await mkdtemp(join(tmpdir(), "phoenix-fx-"));
    await mkdir(join(temporary, ".fx"), { mode: 0o700 });
    await writeFile(join(temporary, ".fx", "settings.json"), JSON.stringify(settings), { mode: 0o600 });
    env.PHOENIX_FX_SOURCE_HOME = homedir();
    env.HOME = temporary;
  } else throw new Error("Subscription endpoints cannot be rewritten");
  const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise(resolve => { child.on("exit", (code, signal) => resolve({ code, signal })); child.on("error", () => resolve({ code: 127 })); });
  process.exitCode = result.code ?? 1;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  signalToRaise = result.signal;
} catch {
  process.stderr.write("Could not route the selected fx model; no configuration is logged\n");
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
if (signalToRaise) process.kill(process.pid, signalToRaise);
