import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readPlugin } from "../packages/plugin-host/src/index.ts";
import { BlobStore, createCapture, digest, readCapture } from "../packages/store/src/index.ts";
import { capturePlugin } from "../packages/capture/src/index.ts";

test("S9: CLI prefetch strips a secret split across stdout fragments", async t => {
  const root = await mkdtemp(join(import.meta.dirname, ".email-S9-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = "synthetic-test-only-credential";
  await writeFile(join(root, "capture.mjs"), `
    import { createInterface } from "node:readline";
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const value = request.method === "initialize" ? null : request.params.phase === "plan"
        ? { calls: [{ op: "review-tool", args: { argv: ["review-tool", "list"] } }] }
        : { collections: [] };
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
    }
  `);
  await writeFile(join(root, "phoenix-plugin.json"), JSON.stringify({
    phoenix_plugin: 1, connector: "review-cli", recognize: { commands: ["review-tool"] },
    tier: "recorded", operations: ["review-tool"], read_only: ["review-tool list"],
    capture: { command: [process.execPath, "capture.mjs"], protocol: "stdio" },
  }));
  const captureRoot = join(root, "capture");
  await createCapture(captureRoot, {
    capture: "review-cli", harness: { name: "review", tree: digest(Buffer.from("synthetic")) },
    recipe: { name: "review", version: "1" }, routes: [],
    started_at: "2026-11-16T12:00:00Z", boot_id: "review",
  });
  await capturePlugin({
    root: captureRoot, home: join(root, "home"), connector: "review-cli",
    plugin: await readPlugin(join(root, "phoenix-plugin.json")),
    target: { surface: "cli", command: [process.execPath, "-e",
      `process.stdout.write('{"password":"'); setTimeout(() => process.stdout.end(${JSON.stringify(marker + '"}')}), 100);`],
      cwd: root, env: { PATH: process.env.PATH, HOME: root } },
  });
  const capture = await readCapture(captureRoot);
  const event = capture.allEvents.find(e => e.kind === "prefetch");
  assert.ok(event?.body?.blob);
  t.diagnostic("Prefetch secret scan status: " + JSON.stringify(event.secrets));
  const stored = JSON.parse(Buffer.from(await new BlobStore(captureRoot).get(event.body.blob)).toString());
  const frames = JSON.parse(stored.response.body);
  const stdout = frames.filter(f => f.dir === "back" && f.stream === 1)
    .map(f => Buffer.from(f.bytes, "base64").toString()).join("");
  assert.equal(stdout.includes(marker), false, "Fragmenting a JSON password field must not persist its value");
});

test("S10: email capture retains reads with global options before subcommands", async t => {
  const root = await mkdtemp(join(import.meta.dirname, ".email-S10-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argv = ["himalaya", "--output", "json", "envelope", "list", "--folder", "INBOX"];
  const segment = join(root, "session.jsonl");
  await writeFile(segment, JSON.stringify({
    v: 1, capture: "review", stream: "cli.email", seq: 0, kind: "call", surface: "cli",
    connector: "email", op: "himalaya", ts: { wall: "2026-11-16T12:00:00Z" },
    body: { inline: JSON.stringify({ argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } }) },
  }) + "\n");
  const child = spawn(process.execPath, ["plugins/email/src/capture.mjs"], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", bytes => output += bytes);
  const closed = once(child, "close");
  child.stdin.end([
    { phoenix_plugin: 1, id: 1, method: "initialize", params: { segments: [segment] } },
    { phoenix_plugin: 1, id: 2, method: "capture", params: { phase: "plan", surface: "cli" } },
  ].map(value => JSON.stringify(value) + "\n").join(""));
  await closed;
  const reply = output.trim().split("\n").map(JSON.parse).find(value => value.id === 2);
  assert.equal(reply.status, "answer", JSON.stringify(reply));
  assert.ok(reply.value.calls.some(call => call.args.argv.includes("envelope")), JSON.stringify(reply.value.calls));
});
