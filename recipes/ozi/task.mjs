import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { thread: { type: "string" }, cwd: { type: "string" }, phoenix: { type: "string", default: "phoenix" } } });
  if (!values.thread || !positionals.length) throw new Error("Usage: task.mjs --thread <Ozi-thread-id> [--cwd <directory>] -- command that waits for the task to finish");
  const marker = op => new Promise(resolve => {
    const child = spawn(values.phoenix, ["task", op, values.thread, ...(op === "start" && values.cwd ? ["--cwd", values.cwd] : [])], { stdio: "ignore" });
    child.once("error", resolve); child.once("exit", resolve);
  });
  await marker("start");
  const child = spawn(positionals[0], positionals.slice(1), { stdio: "inherit" });
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise(resolve => {
    child.once("error", () => resolve({ code: 127 }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await marker("end");
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code ?? 1;
}

await main().catch(() => { process.stderr.write("Ozi task wrapper failed; no task contents logged\n"); process.exitCode = 1; });
