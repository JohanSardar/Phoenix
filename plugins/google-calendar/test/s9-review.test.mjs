import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = fileURLToPath(new URL("../", import.meta.url));

test("S9: resume initializes the copy when its first calendar call is a post-cut write", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(plugin, ".review-S9-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = join(root, "snapshot");
  await writeFile(snapshot, "");

  const child = spawn(process.execPath, [join(plugin, "src/serve.mjs")], {
    cwd: plugin, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC" },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} });
  child.stderr.resume();
  const output = createInterface({ input: child.stdout });
  t.after(() => output.close());
  const response = new Promise(resolve => output.once("line", line => resolve(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: 1, method: "initialize", params: { snapshot } }) + "\n");
  const reply = await response;
  assert.equal(reply.status, "answer", `A valid empty resume snapshot must initialize an empty copy: ${JSON.stringify(reply)}`);
});
