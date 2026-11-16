import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runMomentCommand } from "../packages/cli/src/moment.ts";

test("S1: a session inside the home .ssh folder must not copy private keys", async t => {
  const root = await mkdtemp("/tmp/phoenix-copy-S1-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(home, ".ssh");
  await mkdir(cwd, { recursive: true });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
  await writeFile(join(cwd, "id_ed25519"), "fixture-only private key, not a real secret\n");
  const session = join(root, "session.jsonl"), check = join(root, "check.yaml"), out = join(root, "moment");
  await writeFile(session, [
    { type: "session", version: 3, cwd },
    { type: "model_change", provider: "opencode-go", modelId: "fixture" },
    { type: "message", message: { role: "system", sections: {}, toolsAdded: [] } },
    { type: "message", message: { role: "user", content: "inspect files" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ].map((entry, index) => JSON.stringify({ id: `entry-${index}`, timestamp: "2099-01-01T00:00:00.000Z", ...entry })).join("\n") + "\n");
  await writeFile(check, "phoenix_check: 1\nsamples: {base: 2, tiebreak: 1}\nscope: continuation\nintent: inspect files\n");
  assert.equal(await runMomentCommand(["create", "--session", session, "--recipe", resolve("recipes/pi/recipe.yaml"), "--at", "4", "--id", "copy-s1", "--check", check, "--home", join(root, "phoenix-home"), out]), 0);
  const projectTar = join(out, "data/project.tar");
  const copied = await readFile(projectTar).then(() => execFileSync("tar", ["-tf", projectTar], { encoding: "utf8" }), error => { if (error.code === "ENOENT") return ""; throw error; });
  assert.ok(!copied.split("\n").includes("id_ed25519"), `Login files must be excluded even when cwd is .ssh; copied: ${copied}`);
});
