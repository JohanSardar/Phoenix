import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Copy } from "./google.mjs";
import { Hosted } from "./hosted.mjs";
import { Unknown } from "./time.mjs";
import { dialect, payload, seedAll } from "./seed.mjs";

// The working copy. The real Google Calendar MCP server (@cocal/google-calendar-mcp) runs unchanged; only the
// Google Calendar REST API under it is replaced by an in-memory copy (src/google.mjs) seeded from what the session saw.
// A call the copy cannot answer from what it knows is "unsupported", so the answer chain moves on instead of guessing.

const here = dirname(fileURLToPath(import.meta.url));
function findUp(relative) {
  for (let dir = join(here, ".."); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", relative);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot find ${relative}`);
  }
}

class StdioServer {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.next = 1;
    this.stderr = "";
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    createInterface({ input: this.child.stdout }).on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = message.id !== undefined && this.pending.get(message.id);
      if (waiter) { this.pending.delete(message.id); waiter(message); }
    });
    this.exited = new Promise(resolve => this.child.once("exit", code => resolve(code)));
    this.exited.then(code => { for (const [, waiter] of this.pending) waiter({ jsonrpc: "2.0", error: { code: -32000, message: `server exited (${code}): ${this.stderr}` } }); this.pending.clear(); });
  }
  request(method, params, timeout = 25000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out: ${this.stderr}`)); }, timeout);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }
  notify(method) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); }
  async start() {
    const reply = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phoenix-calendar-copy", version: "1" } }, 60000);
    if (reply.error) throw new Error(reply.error.message);
    this.notify("notifications/initialized");
    return this;
  }
  stop() { this.child.kill("SIGTERM"); }
}

const copy = new Copy();
copy.hosted = new Hosted(copy);
let cocal, adapter, home, base;
const answer = (id, value) => console.log(JSON.stringify({ phoenix_plugin: 1, id, status: "answer", value }));
const reply = (id, status, reason) => console.log(JSON.stringify({ phoenix_plugin: 1, id, status, reason }));

function accounts(answers) {
  const names = new Set();
  for (const a of answers) {
    for (const v of [a.args?.account].flat()) if (typeof v === "string") names.add(v);
    const value = payload(a.result);
    for (const ev of value?.events ?? [value?.event].filter(Boolean)) if (ev?.accountId) names.add(ev.accountId);
  }
  return names.size ? [...names] : ["normal"];
}

// A Snapshot is either { answers, adapter? } (or a bare answers array), or the resume path's JSON Lines of session
// call/result events, each carrying its JSON-RPC message in body.inline.
function readSnapshot(text) {
  const lines = text.split("\n").filter(line => line.trim());
  if (!lines.length) return { answers: [] };
  const events = lines.length > 0 && lines.every(line => { try { return typeof JSON.parse(line).kind === "string"; } catch { return false; } });
  if (!events) {
    const snapshot = JSON.parse(text);
    return Array.isArray(snapshot) ? { answers: snapshot } : { answers: snapshot.answers ?? [], adapter: snapshot.adapter };
  }
  const calls = new Map(), answers = [];
  for (const line of lines) {
    const event = JSON.parse(line);
    const message = typeof event.body?.inline === "string" ? JSON.parse(event.body.inline) : undefined;
    if (!message) continue;
    if (event.kind === "call") calls.set(message.id, { op: message.params?.name ?? String(event.op).replace(/^tools\/call:/, ""), args: message.params?.arguments ?? {} });
    else if (event.kind === "result" && calls.has(message.id) && message.result) answers.push({ ...calls.get(message.id), result: message.result, observed_at: event.ts?.wall });
  }
  return { answers };
}

async function initialize(params) {
  let answers = [], adapterTarget = { calendarId: "primary", account: undefined };
  if (params.snapshot) {
    const snapshot = readSnapshot(await readFile(params.snapshot, "utf8"));
    answers = snapshot.answers;
    if (snapshot.adapter) adapterTarget = { ...adapterTarget, ...snapshot.adapter };
  }
  seedAll(copy, answers, adapterTarget);
  const rest = await copy.serve();
  base = `http://127.0.0.1:${rest.address().port}`;
  home = await mkdtemp(join(tmpdir(), "phoenix-calendar-copy-"));
  const names = accounts(answers);
  adapterTarget.account ??= names[0];
  await writeFile(join(home, "keys.json"), JSON.stringify({ installed: { client_id: "phoenix-copy.apps.googleusercontent.com", client_secret: "phoenix-copy", redirect_uris: ["http://localhost"] } }));
  await writeFile(join(home, "tokens.json"), JSON.stringify(Object.fromEntries(names.map(name => [name, { access_token: "phoenix-copy", refresh_token: "phoenix-copy", scope: "https://www.googleapis.com/auth/calendar", token_type: "Bearer", expiry_date: Date.UTC(2099, 0, 1) }]))));
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, GOOGLE_OAUTH_CREDENTIALS: join(home, "keys.json"), GOOGLE_CALENDAR_MCP_TOKEN_PATH: join(home, "tokens.json"), GOOGLE_CALENDAR_API_BASE_URL: base, ...(process.env.LD_PRELOAD ? { LD_PRELOAD: process.env.LD_PRELOAD } : {}), ...(process.env.TZ ? { TZ: process.env.TZ } : {}), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FAKETIME") || k.startsWith("PHOENIX_CLOCK"))) };
  const server = findUp("@cocal/google-calendar-mcp/build/index.js");
  cocal = await new StdioServer(process.execPath, [server], env).start();
  adapter = { target: adapterTarget, env, server };
}

async function viaAdapter() {
  if (adapter.process) return adapter.process;
  adapter.process = await new StdioServer(process.execPath, [join(here, "mcp.mjs"), adapter.target.calendarId, adapter.target.account, process.execPath, adapter.server], adapter.env).start();
  return adapter.process;
}

async function call(params) {
  if (params.now) copy.now = () => Date.parse(params.now);
  const op = String(params.op ?? "").replace(/^tools\/call:/, "");
  const request = JSON.parse(Buffer.from(params.raw?.body ?? "", "base64").toString("utf8") || "{}");
  const args = request.params?.arguments ?? params.args ?? {};
  const kind = dialect(op, args);
  if (!kind) return { status: "unsupported", reason: `${op} is not a Google Calendar tool the copy knows` };
  copy.takeGaps();
  copy.nextIds = createdIds(params.recorded);
  if (kind === "google") {
    let value;
    try { value = copy.hosted.call(op, args); } catch (error) {
      if (!(error instanceof Unknown)) throw error;
      return { status: "unsupported", reason: `The calendar copy does not know enough to answer: ${[...new Set(copy.takeGaps())].join("; ") || error.message}` };
    }
    const result = value.error ? { content: [{ type: "text", text: value.error }], isError: true } : { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
    return { status: "answer", value: { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n").toString("base64") } };
  }
  const server = kind === "cocal" ? cocal : await viaAdapter();
  const { id: _id, jsonrpc, ...rest } = await server.request("tools/call", { name: op, arguments: args });
  const response = { jsonrpc, id: request.id, ...rest };
  const gaps = copy.takeGaps();
  if (gaps.length) return { status: "unsupported", reason: `The calendar copy does not know enough to answer: ${[...new Set(gaps)].join("; ")}` };
  return { status: "answer", value: { body: Buffer.from(JSON.stringify(response) + "\n").toString("base64") } };
}

// When the engine runs a recorded write against the copy, it also sends the recorded answer. Events that write created
// then take the ids the agent was given, so later calls by those ids reach them.
function createdIds(recorded) {
  let value;
  try { value = payload(JSON.parse(Buffer.from(recorded?.body ?? "", "base64").toString("utf8")).result); } catch { return []; }
  const events = value?.event ? [value.event] : Array.isArray(value?.created) ? value.created : value?.id && value.created ? [value] : [];
  return events.map(e => e?.id).filter(id => typeof id === "string");
}

let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
    if (request.method === "initialize") { await initialize(request.params); initialized = true; answer(request.id, null); continue; }
    if (!initialized) throw new Error("Initialize first");
    if (request.method === "call") { const r = await call(request.params); if (r.status === "answer") answer(request.id, r.value); else reply(request.id, r.status, r.reason); continue; }
    if (request.method === "state") { answer(request.id, copy.state()); continue; }
    reply(request.id, "unsupported", `The calendar copy has no ${request.method} method`);
  } catch (error) {
    reply(request?.id ?? null, "execution-failure", error instanceof Error ? error.message : String(error));
  }
}
cocal?.stop();
adapter?.process?.stop();
