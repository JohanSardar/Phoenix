import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runMomentCommand } from "../packages/cli/src/moment.ts";

test("S7: a project copy preserves tracked files marked export-ignore", async t => {
  const root = await mkdtemp(join(tmpdir(), "phoenix-t11-S7-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), copied = join(root, "copied");
  execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", resolve("."), project]);
  await writeFile(join(project, ".git/info/attributes"), "package.json export-ignore\n");
  const expected = execFileSync("git", ["show", "HEAD:package.json"], { cwd: project });
  await mkdir(copied);
  const time = "2026-11-17T12:00:00.000Z";
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    { type: "session", version: 3, id: "review", cwd: project },
    { type: "model_change", provider: "openai-codex", modelId: "review-model" },
    { type: "message", message: { role: "system", sections: {}, toolsAdded: [] } },
    { type: "message", message: { role: "user", content: "Read package.json" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Read it" }] } },
  ].map((entry, index) => JSON.stringify({ id: `entry-${index}`, timestamp: time, ...entry })).join("\n") + "\n");
  const check = join(root, "check.yaml"), bundle = join(root, "moment");
  await writeFile(check, JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ final_text: { contains: "ok" } }] }));
  assert.equal(await runMomentCommand(["create", "--session", session, "--recipe", resolve("recipes/pi/recipe.yaml"), "--at", "4", "--id", "review", "--check", check, "--home", join(root, "home"), bundle]), 0);
  execFileSync("tar", ["-xf", join(bundle, "data/project.tar"), "-C", copied]);
  const actual = await readFile(join(copied, "package.json")).catch(error => ({ error: error.code }));
  assert.equal(actual.error, undefined, "Export packaging rules must not omit readable committed files from the replay project");
  assert.deepEqual(actual, expected);
});
