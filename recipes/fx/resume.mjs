import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const moment = JSON.parse(readFileSync("/phoenix/moment/moment.json", "utf8"));
const home = "/home/phoenix";
mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 });
for (const name of readdirSync("/phoenix/agent/.fx")) writeFileSync(join(home, ".fx", name), readFileSync(join("/phoenix/agent/.fx", name)), { mode: 0o600 });
const store = join(home, ".fx", "sessions", "v2", moment.session);
mkdirSync(join(store, "blobs"), { recursive: true, mode: 0o700 });

const crc32c = text => {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0x82f63b78 : crc >>> 1;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};
let lines = readFileSync("/phoenix/moment/cut.jsonl", "utf8").split("\n").filter(Boolean).map(line => line.replace(/,"crc":"[0-9a-f]{8}"}$/, "}"));
const blobs = "/phoenix/moment/files/blobs";
for (const name of existsSync(blobs) ? readdirSync(blobs) : []) {
  const bytes = readFileSync(join(blobs, name));
  const hash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(store, "blobs", hash), bytes, { mode: 0o400 });
  if (hash === name) continue;
  lines = lines.map(line => line.includes(name) ? line.replaceAll(name, hash).replace(/"stored_bytes":\d+/, `"stored_bytes":${bytes.length}`) : line);
}
writeFileSync(join(store, "log.jsonl"), lines.map(line => `${line.slice(0, -1)},"crc":"${crc32c(line.slice(0, -1))}"}`).join("\n") + "\n", { mode: 0o600 });
writeFileSync(join(store, "lock"), "", { mode: 0o600 });

mkdirSync(moment.cwd, { recursive: true });
if (existsSync("/worktree/AGENTS.md")) cpSync("/worktree/AGENTS.md", join(moment.cwd, "AGENTS.md"));
const settings = existsSync("/worktree/fx.json") ? JSON.parse(readFileSync("/worktree/fx.json", "utf8")) : {};
const profile = join(home, ".fx", "settings.json");
const saved = JSON.parse(readFileSync(profile, "utf8"));
writeFileSync(profile, JSON.stringify({ ...saved, models: { [moment.model.provider]: moment.model.id } }), { mode: 0o600 });
let fx = "fx";
if (existsSync("/worktree/fx.patch") && statSync("/worktree/fx.patch").size > 0) {
  cpSync("/opt/fx-src", "/tmp/fx-src", { recursive: true });
  const build = { cwd: "/tmp/fx-src", stdio: ["ignore", "inherit", "inherit"] };
  execFileSync("git", ["apply", "/worktree/fx.patch"], build);
  execFileSync("zig", ["build", "-Doptimize=ReleaseSafe"], build);
  fx = "/tmp/fx-src/zig-out/bin/fx";
}
mkdirSync("/tmp/phoenix-calls", { recursive: true, mode: 0o700 });
const child = spawn(fx, ["acp", ...(settings.model ? ["--model", settings.model] : [])], {
  cwd: moment.cwd, stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HOME: home, FX_DISABLE_KEYCHAIN: "1", FX_NO_OPEN_BROWSER: "1", FX_SKIP_ONBOARDING: "1", PHOENIX_FX_TOOL_DIR: "/tmp/phoenix-calls", PHOENIX_FX_TOOL_HELPER: "/phoenix/recipe/tool.mjs" },
});
let next = 0;
const pending = new Map();
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); send({ id, method, params }); });
createInterface({ input: child.stdout }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "session/request_permission") {
    const option = message.params.options.find(o => o.kind === "allow_once") ?? message.params.options.find(o => o.kind.startsWith("allow"));
    send({ id: message.id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
  } else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Not available in a Phoenix replay" } });
  else if (!message.method && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message}`)); else resolve(message.result);
  }
});
const exited = new Promise(resolve => child.once("close", code => resolve(code ?? 1)));
let code = 0;
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await request("session/load", { sessionId: moment.session, cwd: moment.cwd, mcpServers: [] });
  const done = await request("session/prompt", { sessionId: moment.session, prompt: [{ type: "text", text: moment.prompt }] });
  process.stderr.write(`fx stopped: ${done?.stopReason}\n`);
} catch (error) {
  process.stderr.write(`fx resume failed: ${error.message}\n`);
  code = 1;
}
child.stdin.end();
code ||= await Promise.race([exited, new Promise(resolve => setTimeout(() => { child.kill("SIGTERM"); resolve(0); }, 10000))]);
const log = join(store, "log.jsonl");
const records = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
if (records.length) writeFileSync("/phoenix/out/session.jsonl", records.join("\n") + "\n");
const last = records.slice(moment.cut_lines).map(line => JSON.parse(line)).findLast(r => r.kind === "item" && r.type === "assistant");
writeFileSync("/phoenix/out/result.json", JSON.stringify({ session: records.length ? "session.jsonl" : null, final_text: last?.data.text ?? "", code }) + "\n");
process.exitCode = code;
