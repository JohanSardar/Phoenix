// The working copy, served to a replay over the plugin protocol (spec/plugin.md).
// A real Postgres, built from the moment's snapshot, holds the database. Supabase's own MCP server answers each call;
// its management API requests go to the stand-in in api.mjs on this box's loopback, never to Supabase.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import pg from "pg";
import { createCopy } from "./api.mjs";
import { takeSnapshot } from "./dump.mjs";
import { seed } from "./seed.mjs";
import { startCopyServer } from "./server.mjs";

const TEMPLATE = process.env.PHOENIX_SUPABASE_PGDATA ?? "/var/lib/phoenix/pgdata";
let copy, server, postgres, scratch, why, seeded;
let failures = [];

function readSnapshot(path) {
  const textValue = readFileSync(path, "utf8");
  let results = [];
  try {
    const data = JSON.parse(textValue);
    const answers = Array.isArray(data) ? data : data?.answers;
    if (Array.isArray(answers)) results = answers.map(answer => answer?.result);
  } catch {
    for (const line of textValue.split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.kind !== "result" || typeof event.body?.inline !== "string") continue;
      try { results.push(JSON.parse(event.body.inline).result); } catch {}
    }
  }
  const metas = results.map(result => result?._meta ?? {});
  return {
    database: metas.map(meta => meta["phoenix/supabase-database"]).filter(Boolean).at(-1),
    replies: metas.flatMap(meta => meta["phoenix/supabase-api"] ?? []),
    flags: metas.map(meta => meta["phoenix/supabase-server"]).filter(Boolean).at(-1),
  };
}

function pgBin() {
  if (process.env.PHOENIX_PG_BIN) return process.env.PHOENIX_PG_BIN;
  const versions = readdirSync("/usr/lib/postgresql").sort((a, b) => Number(b) - Number(a));
  return join("/usr/lib/postgresql", versions[0], "bin");
}

async function startPostgres(meta, preload) {
  scratch = mkdtempSync(join(tmpdir(), "phoenix-supabase-pg-"));
  const data = join(scratch, "data");
  cpSync(TEMPLATE, data, { recursive: true });
  chmodSync(data, 0o700);
  const same = { statement_timeout: meta.statement_timeout, lc_messages: meta.lc_messages, lc_monetary: meta.lc_monetary, lc_numeric: meta.lc_numeric, lc_time: meta.lc_time, default_text_search_config: meta.text_search, shared_preload_libraries: preload ? meta.preload : undefined, "pgsodium.getkey_script": preload && /\bpgsodium\b/.test(meta.preload ?? "") ? "/usr/local/bin/phoenix-pgsodium-getkey" : undefined };
  const settings = { listen_addresses: "", unix_socket_directories: scratch, TimeZone: meta.timezone, DateStyle: meta.datestyle, IntervalStyle: meta.intervalstyle, ...Object.fromEntries(Object.entries(same).filter(([, value]) => value)), fsync: "off", synchronous_commit: "off", full_page_writes: "off", logging_collector: "off", shared_buffers: "32MB" };
  postgres = spawn(join(pgBin(), "postgres"), ["-D", data, ...Object.entries(settings).flatMap(([name, value]) => ["-c", name + "=" + value])], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  postgres.stderr.on("data", chunk => { log = (log + chunk).slice(-4000); });
  const exited = new Promise(resolve => postgres.once("exit", resolve));
  for (let attempt = 0; attempt < 200; attempt++) {
    const client = new pg.Client({ host: scratch, user: "supabase_admin", database: "postgres" });
    try { await client.connect(); await client.end(); return; } catch { await client.end().catch(() => {}); }
    if (await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(resolve, 100, false))])) break;
  }
  throw new Error("The copy's Postgres did not start: " + log.trim().split("\n").slice(-3).join(" "));
}

async function initialize(params) {
  const { database, replies, flags } = typeof params.snapshot === "string" && existsSync(params.snapshot) ? readSnapshot(params.snapshot) : { replies: [] };
  const ref = flags?.project_ref ?? replies.map(reply => /\/v[12]\/projects\/([^/]+)\//.exec(new URL(reply.url ?? "https://x").pathname)?.[1]).find(Boolean);
  if (!ref) { why = "The snapshot holds nothing from Supabase; take one with phoenix-supabase-snapshot when the moment is made"; return; }
  if (database) {
    const local = Number(/\(PostgreSQL\)\s+(\d+)/.exec(execFileSync(join(pgBin(), "postgres"), ["--version"], { encoding: "utf8" }))?.[1]);
    const wanted = Math.floor(database.meta.version_num / 10000);
    if (local !== wanted) { why = "The copy's Postgres is major version " + local + ", but the snapshot is from Postgres " + wanted + "; build the plugin's image with PG_MAJOR=" + wanted; return; }
    try { await startPostgres(database.meta, true); }
    catch { postgres?.kill(); await startPostgres(database.meta, false); }
    const admin = new pg.Client({ host: scratch, user: "supabase_admin", database: "postgres" });
    await admin.connect();
    try {
      seeded = await seed(admin, database);
      if (database.meta.version_text) await admin.query("CREATE OR REPLACE FUNCTION pg_catalog.version() RETURNS text LANGUAGE sql STABLE AS $phoenix$ SELECT " + "'" + database.meta.version_text.replaceAll("'", "''") + "'::text $phoenix$");
    } finally { await admin.end(); }
    if (seeded.errors.length || seeded.skipped.length) process.stderr.write("phoenix-supabase: " + JSON.stringify(seeded) + "\n");
  }
  copy = createCopy({ snapshot: database, replies, socket: scratch, database: database?.meta.database ?? "postgres" });
  await copy.ready();
  const api = createServer(async (request, response) => {
    let answer;
    try { answer = await copy.handle(request.method, request.url, request.headers["x-phoenix-host"] ?? "api.supabase.com", await text(request)); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); answer = { status: 500, headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify({ message: String(error) })) }; }
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(answer.body);
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  server = await startCopyServer({ copy: "http://127.0.0.1:" + api.address().port, flags: { read_only: flags?.read_only ?? true, project_ref: ref, features: flags?.features } });
}

function rpc(id, outcome) {
  return { status: "answer", value: { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...outcome })).toString("base64") } };
}

async function call(params) {
  if (why) return { status: "unsupported", reason: why };
  const message = JSON.parse(Buffer.from(params.raw.body, "base64").toString("utf8"));
  if (message.method !== "tools/call" || typeof message.params?.name !== "string") return { status: "unsupported", reason: "The Supabase copy answers tool calls only" };
  copy.begin();
  failures = [];
  if (message.params.name === "phoenix_database_snapshot") {
    const args = message.params.arguments ?? {};
    const run = async query => {
      const answer = await copy.handle("POST", "/v1/projects/copy/database/query", "api.supabase.com", JSON.stringify({ query, read_only: true }));
      if (answer.status >= 300) throw new Error(JSON.parse(answer.body.toString("utf8")).message);
      return JSON.parse(answer.body.toString("utf8"));
    };
    try {
      const database = await takeSnapshot(run, { schemas: Array.isArray(args.schemas) ? args.schemas : [], tables: Array.isArray(args.tables) ? args.tables : [], rowLimit: Number(args.row_limit ?? 1000) });
      const misses = copy.end();
      if (misses.length) return { status: "unsupported", reason: misses.join("; ") };
      return rpc(message.id, { result: { content: [{ type: "text", text: "Read the structure of " + database.relations.length + " relations from the working copy." }], _meta: { "phoenix/supabase-database": database } } });
    } catch (error) { copy.end(); return rpc(message.id, { result: { content: [{ type: "text", text: String(error.message ?? error) }], isError: true } }); }
  }
  let answer, misses;
  try { answer = await server.request("tools/call", { name: message.params.name, arguments: message.params.arguments ?? {} }); }
  finally { misses = copy.end(); }
  if (failures.length) return { status: "execution-failure", reason: "The Supabase copy failed: " + failures.join("; ") };
  if (misses.length) return { status: "unsupported", reason: "The Supabase copy cannot answer this like Supabase would: " + misses.join("; ") };
  const { jsonrpc: _, id: __, ...outcome } = answer;
  return rpc(message.id, outcome);
}

const reply = (id, outcome) => process.stdout.write(JSON.stringify({ phoenix_plugin: 1, id, ...outcome }) + "\n");
let tail = Promise.resolve();
async function stop() {
  await server?.close().catch(() => {});
  postgres?.kill("SIGINT");
  if (postgres) await new Promise(resolve => postgres.exitCode !== null ? resolve() : postgres.once("exit", resolve));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
createInterface({ input: process.stdin }).on("line", line => {
  tail = tail.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
      if (request.method === "initialize") { await initialize(request.params); return reply(request.id, { status: "answer", value: null }); }
      if (!copy && !why) throw new Error("Initialize first");
      if (request.method === "call") return reply(request.id, await call(request.params));
      if (request.method === "state") return reply(request.id, { status: "answer", value: why ? { unavailable: why } : { ...(await copy.state()), seed: seeded ?? null } });
      reply(request.id, { status: "unsupported", reason: "The Supabase copy has no " + request.method });
    } catch (error) {
      reply(request?.id ?? null, { status: "execution-failure", reason: error instanceof Error ? error.message : String(error) });
    }
  });
}).on("close", async () => { await tail; await stop(); process.exit(0); });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stop(); process.exit(0); });
