import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runMomentCommand } from "../packages/cli/src/moment.ts";

test("S5: the files copy preserves project files a new read can need", async t => {
  const root = await mkdtemp(join(tmpdir(), "phoenix-t11-S5-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), copied = join(root, "copied");
  await mkdir(project);
  await mkdir(copied);
  const files = new Map([
    ["data.json", Buffer.from(JSON.stringify({ value: "x".repeat(1024 * 1024) }))],
    ["asset.bin", Buffer.alloc(70 * 1024)],
  ]);
  for (const [name, bytes] of files) await writeFile(join(project, name), bytes);
  const time = "2026-11-01T12:00:00.000Z";
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    { type: "session", version: 3, id: "review", cwd: project },
    { type: "model_change", provider: "openai-codex", modelId: "review-model" },
    { type: "message", message: { role: "system", sections: {}, toolsAdded: [] } },
    { type: "message", message: { role: "user", content: "Describe this project" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A data project" }] } },
  ].map((entry, index) => JSON.stringify({ id: `entry-${index}`, timestamp: time, ...entry })).join("\n") + "\n");
  const check = join(root, "check.yaml"), bundle = join(root, "moment");
  await writeFile(check, JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ final_text: { contains: "ok" } }] }));
  assert.equal(await runMomentCommand(["create", "--session", session, "--recipe", resolve("recipes/pi/recipe.yaml"), "--at", "4", "--id", "review", "--check", check, "--home", join(root, "home"), bundle]), 0);
  execFileSync("tar", ["-xf", join(bundle, "data/project.tar"), "-C", copied]);
  const missing = [];
  for (const [name, expected] of files) {
    const actual = await readFile(join(copied, name)).catch(error => ({ error: error.code }));
    if (!Buffer.isBuffer(actual)) missing.push({ file: name, ...actual });
    else assert.deepEqual(actual, expected);
    assert.deepEqual(await readFile(join(project, name)), expected);
  }
  assert.deepEqual(missing, [], "New file reads must see the project's bytes, not ENOENT caused by a copy-size limit");
});
