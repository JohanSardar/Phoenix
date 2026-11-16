// The working copy, served to a replay over the plugin protocol (spec/plugin.md).
// Sentry's own MCP server answers each call; its Sentry API calls go to the copy in copy.mjs, never to Sentry.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { createCopy } from "./copy.mjs";
import { startSentryServer } from "./server.mjs";

let copy;
let server;
let api;

function results(text) {
  try {
    const data = JSON.parse(text);
    const answers = Array.isArray(data) ? data : data?.answers;
    if (!Array.isArray(answers)) throw new Error("The snapshot must be a list of tool answers, or a session moment with answers");
    return answers.map(answer => answer?.result);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === "result" && event.surface !== "cli" && typeof event.body?.inline === "string").map(event => JSON.parse(event.body.inline).result);
}

async function initialize(params) {
  const saved = typeof params.snapshot === "string" ? readFileSync(params.snapshot, "utf8") : "";
  copy = createCopy(results(saved).flatMap(result => result?._meta?.["phoenix/sentry-api"] ?? []));
  api = createServer(async (request, response) => {
    const body = await text(request);
    const answer = copy.handle(request.method, request.url, body || undefined);
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(answer.body);
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  server = await startSentryServer({ mode: "copy", token: "phoenix-working-copy", copy: `http://127.0.0.1:${api.address().port}` });
  return null;
}

// The real sentry command line, with only its Sentry API calls sent to the copy (route.mjs), in a home of its own.
const cliBin = join(dirname(createRequire(import.meta.url).resolve("sentry")), "bin.cjs");
let cliHome;
function runCli(argv, stdin) {
  cliHome ??= mkdtempSync(join(tmpdir(), "phoenix-sentry-cli-"));
  const child = spawn(process.execPath, [cliBin, ...argv], {
    cwd: cliHome,
    env: {
      PATH: process.env.PATH ?? "", HOME: cliHome, TZ: process.env.TZ ?? "UTC", SENTRY_AUTH_TOKEN: "phoenix-working-copy",
      SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1",
      NODE_OPTIONS: `--import ${join(import.meta.dirname, "route.mjs")}`, PHOENIX_SENTRY_MODE: "copy", PHOENIX_SENTRY_COPY: `http://127.0.0.1:${api.address().port}`,
    },
  });
  const out = [], err = [];
  child.stdout.on("data", chunk => out.push(chunk));
  child.stderr.on("data", chunk => err.push(chunk));
  child.stdin.end(stdin);
  return new Promise(resolve => child.once("close", code => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code })));
}

async function command(params) {
  const frame = (stream, bytes) => ({ dir: "back", stream, bytes: Buffer.from(bytes).toString("base64"), last: true });
  const answer = (stdout, stderr, code) => ({ status: "answer", value: { body: Buffer.from(JSON.stringify([frame(1, stdout), frame(2, stderr), frame(3, JSON.stringify({ type: "exit", code, signal: null }))])).toString("base64") } });
  const argv = (params.args?.argv ?? []).slice(1);
  copy.begin(params.now);
  let ran, misses;
  try { ran = await runCli(argv, Buffer.from(params.raw?.stdin ?? "", "base64")); }
  finally { misses = copy.end(); }
  if (misses.length) return { status: "unsupported", reason: `The Sentry copy cannot answer this like Sentry would: ${misses.join("; ")}` };
  return answer(ran.stdout, ran.stderr, ran.code);
}

async function call(params) {
  if (params.surface === "cli") return command(params);
  const message = JSON.parse(Buffer.from(params.raw.body, "base64").toString("utf8"));
  if (message.method !== "tools/call" || typeof message.params?.name !== "string") return { status: "unsupported", reason: "The Sentry copy answers tool calls only" };
  copy.begin(params.now);
  let answer, misses;
  try { answer = await server.request("tools/call", { name: message.params.name, arguments: message.params.arguments ?? {} }); }
  finally { misses = copy.end(); }
  if (misses.length) return { status: "unsupported", reason: `The Sentry copy cannot answer this like Sentry would: ${misses.join("; ")}` };
  const { jsonrpc, id: _, ...outcome } = answer;
  return { status: "answer", value: { body: Buffer.from(JSON.stringify({ jsonrpc, id: message.id, ...outcome })).toString("base64") } };
}

const reply = (id, outcome) => process.stdout.write(JSON.stringify({ phoenix_plugin: 1, id, ...outcome }) + "\n");
let tail = Promise.resolve();
createInterface({ input: process.stdin }).on("line", line => {
  tail = tail.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
      if (request.method === "initialize") return reply(request.id, { status: "answer", value: await initialize(request.params) });
      if (!server) throw new Error("Initialize first");
      if (request.method === "call") return reply(request.id, await call(request.params));
      if (request.method === "state") return reply(request.id, { status: "answer", value: copy.state() });
      reply(request.id, { status: "unsupported", reason: `The Sentry copy has no ${request.method}` });
    } catch (error) {
      reply(request?.id ?? null, { status: "execution-failure", reason: error instanceof Error ? error.message : String(error) });
    }
  });
}).on("close", async () => { await tail; await server?.close(); process.exit(0); });
