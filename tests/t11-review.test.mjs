import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { approveCheck, ledgerPath, reviewDraft } from "../packages/approvals/src/index.ts";
import { runMomentCommand } from "../packages/cli/src/moment.ts";
import { evaluateCheck, sampleVerdict } from "../packages/checks/src/index.ts";
import { createSimulator, startToolStandIn } from "../packages/engine/src/index.ts";
import { Runner, treeDigest } from "../packages/runner/src/index.ts";
import { writeMomentBundle } from "../packages/store/src/index.ts";
import { adapterCall } from "../recipes/pi/adapter.mjs";

const time = "2026-11-01T12:00:00.000Z";
const image = `sha256:${"1".repeat(64)}`;

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "phoenix-t11-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function simulator(t, root) {
  const url = await listen(t, httpServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ content: [{ type: "text", text: "simulated answer" }], isError: false }) }] }] }));
  }));
  return createSimulator({ moment: "review", root: join(root, "simulator"), configuration: { model: "review-simulator", endpoint: url + "/responses", dialect: "responses", maxOutputTokens: 1024 }, headers: {}, improverModel: "review-improver" });
}

async function tools(t, root, options) {
  const standIn = await startToolStandIn({
    host: "phoenix-tools", answers: [], policy: () => ({ allow_synthesized: true }), inBox: () => false, cutTime: time,
    sample: { root: join(root, "trace"), metadata: { capture: "review", harness: { name: "review", tree: image }, recipe: { name: "review", version: "1" }, routes: ["tap"], started_at: time, boot_id: "review" } },
    hmacKey: Buffer.alloc(32, 1), ...options,
  });
  t.after(() => standIn.close());
  const url = await listen(t, tcpServer(stream => standIn.accept({ destination: { host: "phoenix-tools", port: 80 }, stream })));
  return { url, ask: async (connector, op, args) => {
    const response = await fetch(url + "/" + encodeURIComponent(connector), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op, arguments: args } }),
    });
    return response.json();
  } };
}

test("S1: a new adapter connector receives a synthesized answer", async t => {
  const root = await scratch(t);
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "note.txt"), "original");
  const entries = [
    { type: "session", version: 3, id: "review", cwd: project },
    { type: "model_change", provider: "openai-codex", modelId: "review-model" },
    { type: "message", message: { role: "system", sections: {}, toolsAdded: [{ name: "mcp", description: "Servers: service", parameters: { type: "object" } }] } },
    { type: "message", message: { role: "user", content: "Read note.txt" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "note.txt" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "original" }] } },
    { type: "message", message: { role: "user", content: "Ask the configured service for its status" } },
  ].map((entry, i) => ({ id: `entry-${i}`, timestamp: time, ...entry }));
  const session = join(root, "session.jsonl"), check = join(root, "check.yaml"), bundle = join(root, "moment");
  await writeFile(session, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(check, JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ final_text: { contains: "ok" } }] }));
  assert.equal(await runMomentCommand(["create", "--session", session, "--recipe", join(import.meta.dirname, "../recipes/pi/recipe.yaml"), "--at", "7", "--id", "review", "--check", check, "--home", join(root, "home"), bundle]), 0);
  const moment = (await reviewDraft(bundle)).manifest;
  const reading = JSON.parse(await readFile(join(bundle, "data/session-moment.json"), "utf8"));
  const endpoint = await tools(t, root, {
    answers: reading.answers.map(a => ({ ...a, observedAt: a.observed_at, beforeCut: a.before_cut })),
    policy: connector => moment.connectors?.[connector] ?? {}, simulator: await simulator(t, root),
  });
  const call = adapterCall("mcp", { tool: "service_status", args: {} }, reading.loadout.adapter);
  assert.equal(call.connector, "service");
  const reply = await endpoint.ask(call.connector, call.op, call.args);
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.result.content[0].text, "simulated answer");
});

test("S2: an unseen OpenCode tool gets a usable synthesized output", async t => {
  const root = await scratch(t);
  const endpoint = await tools(t, root, {
    answers: [{ id: "read-1", connector: "opencode", op: "read", args: { filePath: "known.txt" }, result: { output: "known", title: "known.txt", metadata: {} }, observedAt: time, beforeCut: true }],
    simulator: await simulator(t, root),
  });
  const loadout = join(root, "loadout.json");
  await writeFile(loadout, JSON.stringify({ tools: ["bash", "read"], in_box: ["read"] }));
  const saved = Object.fromEntries(["PHOENIX_OPENCODE_LOADOUT", "PHOENIX_TOOLS_URL", "PHOENIX_PROJECT"].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.PHOENIX_OPENCODE_LOADOUT = loadout;
  process.env.PHOENIX_TOOLS_URL = endpoint.url;
  process.env.PHOENIX_PROJECT = "/copied-project";
  const { PhoenixStandIn } = await import("../recipes/opencode/stand-in.mjs");
  const plugin = await PhoenixStandIn();
  const answer = await plugin.tool.bash.execute({ command: "date", description: "Check the date" }, { callID: "new-bash", abort: new AbortController().signal });
  assert.equal(answer.output, "simulated answer", "a schema-valid synthesized result must reach OpenCode as tool output");
});

test("S3: repeating a session read is counted as session, not a working copy", async t => {
  const root = await scratch(t);
  const recipe = join(root, "recipe");
  const harness = join(root, "harness");
  await mkdir(recipe);
  await mkdir(harness);
  await writeFile(join(harness, "instructions.txt"), "review");
  await writeFile(join(recipe, "recipe.json"), JSON.stringify({
    phoenix_recipe: 1, name: "review", harness_versions: ["1"], routes: [{ versions: "1", login_mode: "api-key", surfaces: { mcp: ["transcript"] } }],
    resume: { moment: [process.execPath], login: [process.execPath, "-e", ""], image: "unused", command: [process.execPath], llm_hosts: { review: ["llm.invalid"] } },
  }));
  const moment = join(root, "moment");
  await writeMomentBundle(moment, {
    manifest: { phoenix_moment: 1, id: "review", source: "snapshot", run: { capture: "review" }, mark: "review:0", clock: { time, timezone: "UTC" }, model: { id: "review/model" }, connectors: { files: { surface: "mcp", tier: "recorded", origin: "captured", routes: ["transcript"], read_only: [{ op: "tools/call:read", source: "annotation" }] } }, resume: { recipe: "review", session: "data/session.jsonl", moment: "data/moment.json" } },
    files: new Map([
      ["check.draft.yaml", JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ final_text: { contains: "ok" } }] })],
      ["data/session.jsonl", "{}\n"],
      ["data/moment.json", JSON.stringify({ cut_lines: 1, prompt: "read twice", model: { provider: "review", id: "model" }, loadout: {}, answers: [{ id: "read-1", connector: "files", op: "read", args: { path: "note.txt" }, result: { content: [{ type: "text", text: "note" }] }, observed_at: time, before_cut: false }] })],
    ]),
  });
  const home = join(root, "home");
  await approveCheck(moment, { home, who: "review", reviewed: (await reviewDraft(moment)).digest });
  const sandbox = { async start(spec) {
    const channel = new Readable({ objectMode: true, read() {} });
    const server = tcpServer(stream => channel.push({ destination: { host: "phoenix-tools", port: 80 }, stream }));
    const url = await listen(t, server);
    const exited = (async () => {
      for (let id = 0; id < 2; id++) {
        const response = await fetch(url + "/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read", arguments: { path: "note.txt" } } }) });
        const reply = await response.json();
        assert.equal(reply.result.content[0].text, "note");
      }
      const out = spec.mounts.find(mount => mount.target === "/phoenix/out").source;
      await writeFile(join(out, "result.json"), JSON.stringify({ session: null, final_text: "ok" }));
      return { code: 0, signal: null };
    })();
    return { channel, process: { id: "node-only-review", stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exited, interrupted: new Promise(() => {}), clock: { clock: "virtual", binaries: [] }, async stop() {}, async exec() { return { code: 0, stdout: "", stderr: "" }; } } };
  } };
  const runner = new Runner({ root: join(root, "runner"), ledger: ledgerPath(home), sandbox });
  const tree = { directory: harness, digest: await treeDigest(harness) };
  const id = await runner.replay({ moment, base: tree, candidate: tree, harness: { phoenix_harness: 1, name: "review", run: { resume: {} }, editable: ["instructions.txt"] }, recipe: join(recipe, "recipe.json"), image, start: "beginning" });
  const result = (await runner.status(id)).result;
  assert.equal(result.samples[0].status, "pass");
  assert.deepEqual(result.samples[0].answers, { session: 2, files_copy: 0, working_copy: 0, made_up: 0, made_up_calls: [] });
});

test("S4: a later divergence does not hide a failure's made-up dependency", async () => {
  const events = [
    { kind: "result", connector: "service", op: "tools/call:status", provenance: "synthesized", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Approval granted" }] } }) } },
    { kind: "call", connector: "service", op: "tools/call:publish", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "publish", arguments: {} } }) } },
    { kind: "divergence", connector: "service", op: "tools/call:next", body: { inline: JSON.stringify({ trigger: "no-answer", detail: "simulator exhausted response validation retries" }) } },
  ].map((event, seq) => ({ v: 1, capture: "review", stream: "stand-in.service", seq, surface: "mcp", layer: "agent", route: "tap", ts: { wall: time, mono: String(seq) }, ...event }));
  const assessed = await evaluateCheck({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ not_called: { tool: "service.publish" } }] }, { trace: events });
  assert.equal(assessed.evidence.error, undefined);
  assert.equal(assessed.expectations[0].outcome, "fail");
  assert.equal(assessed.expectations[0].tainted, true);
  assert.deepEqual(sampleVerdict({ ...assessed, diverged: true }), { status: "fail", discounted: false, leaned_on_made_up: true });
});
