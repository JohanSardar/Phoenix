// The working copy, served to a replay over the plugin protocol (spec/plugin.md).
// Sentry's own MCP server answers each tool call, and the real sentry command line answers each sentry line; their
// Sentry API calls go to the copy in copy.mjs, never to Sentry.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { runCli } from "./cli.mjs";
import { createCopy } from "./copy.mjs";
import { startSentryServer } from "./server.mjs";

let copy;
let server;
let api;

function results(text) {
  try {
    const data = JSON.parse(text);
    if (typeof data?.kind === "string") throw new SyntaxError("one capture event");
    const answers = Array.isArray(data) ? data : data?.answers;
    if (!Array.isArray(answers)) throw new Error("The snapshot must be a list of tool answers, or a session moment with answers");
    return answers.map(answer => answer?.result);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === "result" && event.surface !== "cli" && typeof event.body?.inline === "string").map(event => JSON.parse(event.body.inline).result);
}

// The API replies behind a mark's sentry command-line reads (prefetch events), as src/cli-snapshot.mjs printed them.
function commandLines(text) {
  const events = [];
  for (const line of text.split("\n").filter(Boolean)) { try { events.push(JSON.parse(line)); } catch { return []; } }
  return events.filter(event => event?.kind === "prefetch" && event.surface === "cli" && typeof event.body?.inline === "string").flatMap(event => {
    try {
      const frames = JSON.parse(JSON.parse(event.body.inline).response.body);
      return JSON.parse(Buffer.concat(frames.filter(f => f.dir === "back" && f.stream === 1).map(f => Buffer.from(f.bytes, "base64"))).toString("utf8")).api ?? [];
    } catch { return []; }
  });
}

function snapshotLines(path) {
  const text = readFileSync(path, "utf8");
  return [...results(text).flatMap(result => result?._meta?.["phoenix/sentry-api"] ?? []), ...commandLines(text)].filter(line => line?.method === "GET");
}

async function initialize(params) {
  if (typeof params.snapshot !== "string") throw new Error("The Sentry copy needs a snapshot");
  copy = createCopy(snapshotLines(params.snapshot));
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

async function command(params) {
  const frame = (stream, bytes) => ({ dir: "back", stream, bytes: Buffer.from(bytes).toString("base64"), last: true });
  copy.begin(params.now);
  let ran, misses;
  try { ran = await runCli((params.args?.argv ?? []).slice(1), { stdin: Buffer.from(params.raw?.stdin ?? "", "base64"), token: "phoenix-working-copy", mode: "copy", copy: `http://127.0.0.1:${api.address().port}` }); }
  finally { misses = copy.end(); }
  if (misses.length) return { status: "unsupported", reason: `The Sentry copy cannot answer this like Sentry would: ${misses.join("; ")}` };
  return { status: "answer", value: { body: Buffer.from(JSON.stringify([frame(1, ran.stdout), frame(2, ran.stderr), frame(3, JSON.stringify({ type: "exit", code: ran.code, signal: null }))])).toString("base64") } };
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
