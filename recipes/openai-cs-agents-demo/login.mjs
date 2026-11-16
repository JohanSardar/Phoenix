import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-agent-dir> <provider>");
const stop = reason => { process.stderr.write(`${reason}\n`); process.exit(1); };
const saved = (file, name) => { try { return JSON.parse(readFileSync(file, "utf8"))[name]; } catch { return undefined; } };
const { model } = JSON.parse(readFileSync(join(directory, "..", "moment", "moment.json"), "utf8"));

let login, probe;
if (provider === "opencode-go") {
  const key = saved(join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"), provider);
  if (key?.type !== "api" || !key.key) stop(`OpenCode keeps no ${provider} key on this machine`);
  login = { provider, base: "https://opencode.ai/inference/go/openai/v1", key: key.key };
  probe = { path: "/chat/completions", headers: { "x-opencode-session": randomUUID() }, body: { model: model.id, messages: [{ role: "user", content: "Say ok." }], max_tokens: 16 } };
} else if (provider === "openai-codex") {
  const oauth = saved(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"), provider);
  if (oauth?.type !== "oauth" || !oauth.access) stop(`pi keeps no ${provider} login on this machine`);
  if (!(oauth.expires > Date.now() + 15 * 60 * 1000)) stop(`pi's ${provider} login expires within 15 minutes; run pi once on this machine to refresh it, then replay again`);
  login = { provider, base: "https://chatgpt.com/backend-api/codex", key: oauth.access, account: oauth.accountId };
  probe = { path: "/responses", headers: { "chatgpt-account-id": oauth.accountId, originator: "phoenix", "OpenAI-Beta": "responses=experimental", accept: "text/event-stream" }, body: { model: model.id, store: false, stream: true, instructions: "Say ok.", input: [{ role: "user", content: "Say ok." }] } };
} else stop(`The demo's recipe has no LLM route for ${provider}; it knows opencode-go and openai-codex`);

const host = new URL(login.base).host;
let response;
try {
  response = await fetch(login.base + probe.path, { method: "POST", headers: { authorization: `Bearer ${login.key}`, "content-type": "application/json", ...probe.headers }, body: JSON.stringify(probe.body), signal: AbortSignal.timeout(60_000) });
} catch (error) { stop(`the harness's LLM at ${host} could not be reached: ${error.cause?.message ?? error.message}`); }
if (!response.ok) {
  const text = await response.text();
  let said;
  try { const reply = JSON.parse(text); said = reply.error?.message ?? reply.detail ?? reply.message; } catch {}
  said = String(said || text || `HTTP ${response.status}`).trim().split(/\.\s/)[0].replace(/\.$/, "");
  stop(`the harness's LLM at ${host} refused (HTTP ${response.status}): ${said.charAt(0).toLowerCase()}${said.slice(1)}`);
}
await response.body?.cancel();
writeFileSync(join(directory, "llm.json"), JSON.stringify(login), { mode: 0o600 });
