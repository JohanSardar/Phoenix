import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "../packages/setup/node_modules/yaml/dist/index.js";
import { createCapture, createTraceWriter } from "../packages/store/src/index.ts";
import { createSessionMoment } from "../packages/setup/src/session.ts";

const execute = promisify(execFile);
const time = "2099-01-01T00:00:00.000Z";

async function snapshot(t: { after(fn: () => Promise<void>): void }, git: boolean, seed: (cwd: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "phoenix-s7-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  await seed(cwd);
  if (git) {
    await execute("git", ["init", "-q"], { cwd });
    await execute("git", ["add", "--all"], { cwd });
    const tree = (await execute("git", ["write-tree"], { cwd })).stdout.trim();
    const commit = (await execute("git", ["commit-tree", tree, "-m", "review fixture"], { cwd })).stdout.trim();
    await execute("git", ["update-ref", "HEAD", commit], { cwd });
  }
  const capture = join(root, "capture");
  await createCapture(capture, { capture: "s7-review", harness: { name: "pi", tree: "unknown" }, recipe: { name: "pi", version: "1" }, routes: ["transcript"], started_at: time, boot_id: "s7-review" });
  const writer = createTraceWriter(capture, { capture: "s7-review", stream: "session" });
  writer.append({ v: 1, capture: "s7-review", stream: "session", seq: 0, ts: { wall: time }, kind: "call", source_line: 3, connector: "pi", surface: "cli", op: "prompt", body: { inline: "inspect the project" } });
  await writer.close();
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    { type: "session", version: 3, cwd },
    { type: "model_change", provider: "opencode-go", modelId: "fixture" },
    { type: "message", timestamp: time, message: { role: "user", content: "inspect the project" } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const check = join(root, "check.yaml");
  await writeFile(check, "phoenix_check: 1\nsamples: {base: 2, tiebreak: 1}\nscope: continuation\nintent: preserve the project\n");
  const directory = resolve("recipes/pi");
  const descriptor = parse(await readFile(join(directory, "recipe.yaml"), "utf8"));
  const out = join(root, "moment");
  const manifest = await createSessionMoment({ recipe: { directory, descriptor }, session, capture, at: 3, id: "s7-review", check, out, policy: { hmacKey: new Uint8Array(32).fill(1) } });
  const restored = join(root, "restored");
  await mkdir(restored);
  for (const part of [manifest.resume!.project!.tar, ...manifest.resume!.project!.more ?? []]) {
    await execute("tar", ["-xf", join(out, part), "-C", restored]);
  }
  return { cwd, restored, manifest };
}

test("S7: copies committed bytes despite export attributes and preserves modes and symlinks", async t => {
  const { cwd, restored, manifest } = await snapshot(t, true, async cwd => {
    await writeFile(join(cwd, ".gitattributes"), "hidden.txt export-ignore\nsubst.txt export-subst\n");
    await writeFile(join(cwd, "hidden.txt"), "committed hidden bytes\n");
    await writeFile(join(cwd, "subst.txt"), "$Format:%H$\n");
    await writeFile(join(cwd, "run.sh"), "#!/bin/sh\necho committed\n");
    await chmod(join(cwd, "run.sh"), 0o755);
    await symlink("hidden.txt", join(cwd, "link"));
  });
  assert.equal(manifest.resume!.project!.source, "git");
  for (const name of [".gitattributes", "hidden.txt", "subst.txt", "run.sh"]) {
    const expected = (await execute("git", ["rev-parse", `HEAD:${name}`], { cwd })).stdout.trim();
    const actual = (await execute("git", ["hash-object", "--no-filters", join(restored, name)], { cwd })).stdout.trim();
    assert.equal(actual, expected, name);
  }
  assert.ok((await lstat(join(restored, "run.sh"))).mode & 0o111);
  assert.equal(await readlink(join(restored, "link")), "hidden.txt");
});

test("S8: a tracked filename containing a tab survives a project snapshot", async t => {
  const name = "report\t2026.txt";
  const { restored } = await snapshot(t, true, async cwd => {
    await writeFile(join(cwd, name), "committed report\n");
  });
  assert.equal(await readFile(join(restored, name), "utf8"), "committed report\n");
});

test("S9: a non-git project retains empty directories needed by later writes", async t => {
  const { restored } = await snapshot(t, false, async cwd => {
    await writeFile(join(cwd, "input.txt"), "input\n");
    await mkdir(join(cwd, "output", "nested"), { recursive: true });
  });
  await writeFile(join(restored, "output", "nested", "result.txt"), "result\n");
  assert.equal(await readFile(join(restored, "output", "nested", "result.txt"), "utf8"), "result\n");
});
