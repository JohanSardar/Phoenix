import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCapture, digest } from "@phoenix/store";
import type { WorkdirSnapshot } from "@phoenix/formats";
import { snapshot } from "./index.ts";

test("working-directory snapshot removes the source of a staged rename", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-snapshot-rename-"));
  try {
    const source = join(scratch, "repo"), root = join(scratch, "capture");
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", repo, source]);
    execFileSync("git", ["checkout", "--quiet", "--detach", "HEAD"], { cwd: source });
    execFileSync("git", ["mv", "reference-harness/data/preferences.txt", "reference-harness/data/preferences-renamed.txt"], { cwd: source });
    const started = new Date().toISOString();
    await createCapture(root, { capture: "rename-proof", harness: { name: "reference-harness", tree: digest(Buffer.from("proof")) }, recipe: { name: "generic", version: "1" }, routes: [], started_at: started, boot_id: "proof" });
    await snapshot({ root, home: join(scratch, "home"), cwd: join(source, "reference-harness"), run: "default", started, copyIgnored: false });
    const manifest = JSON.parse(await readFile(join(root, "workdir/default.json"), "utf8")) as WorkdirSnapshot;
    assert.equal(manifest.incomplete, false);
    assert.ok(manifest.entries.some(entry => entry.path === "data/preferences-renamed.txt"));
    assert.equal(manifest.entries.some(entry => entry.path === "data/preferences.txt"), false, "a file removed by git mv must not survive as a committed snapshot entry");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
