import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runMomentCommand } from "../packages/cli/src/moment.ts";

test("S2: moment create accepts an output whose parent does not exist yet", async t => {
  const root = await mkdtemp("/tmp/phoenix-copy-S2-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(home);
  await mkdir(cwd);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
  await writeFile(join(cwd, "note.txt"), "fixture note\n");
  const session = join(root, "session.jsonl"), check = join(root, "check.yaml"), out = join(root, "new-parent", "moment");
  await writeFile(session, [
    { type: "session", version: 3, cwd },
    { type: "model_change", provider: "opencode-go", modelId: "fixture" },
    { type: "message", message: { role: "system", sections: {}, toolsAdded: [] } },
    { type: "message", message: { role: "user", content: "inspect files" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ].map((entry, index) => JSON.stringify({ id: `entry-${index}`, timestamp: "2099-01-01T00:00:00.000Z", ...entry })).join("\n") + "\n");
  await writeFile(check, "phoenix_check: 1\nsamples: {base: 2, tiebreak: 1}\nscope: continuation\nintent: inspect files\n");
  assert.equal(await runMomentCommand(["create", "--session", session, "--recipe", resolve("recipes/pi/recipe.yaml"), "--at", "4", "--id", "copy-s2", "--check", check, "--home", join(root, "phoenix-home"), out]), 0);
  assert.ok((await readFile(join(out, "moment.yaml"), "utf8")).includes("copy-s2"));
});
