import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveCheck, ledgerPath, reviewDraft } from "../packages/approvals/src/index.ts";
import { Runner, treeDigest } from "../packages/runner/src/index.ts";
import { writeMomentBundle } from "../packages/store/src/index.ts";

test("S6: a resume plan accepts a plugin that recognizes the session's MCP name", async t => {
  const root = await mkdtemp(join(tmpdir(), "phoenix-t11-S6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = `sha256:${"1".repeat(64)}`, time = "2026-11-01T12:00:00.000Z";
  const recipe = join(root, "recipe"), harness = join(root, "harness"), plugin = join(root, "plugin");
  for (const directory of [recipe, harness, plugin]) await mkdir(directory);
  await writeFile(join(harness, "AGENTS.md"), "Read my calendar.");
  await writeFile(join(recipe, "recipe.json"), JSON.stringify({
    phoenix_recipe: 1, name: "review", harness_versions: ["1"], routes: [{ versions: "1", login_mode: "api-key", surfaces: { mcp: ["transcript"] } }],
    resume: { moment: [process.execPath], login: [process.execPath, "-e", ""], image: "unused", command: [process.execPath], llm_hosts: { review: ["llm.invalid"] } },
  }));
  await writeFile(join(plugin, "phoenix-plugin.json"), JSON.stringify({
    phoenix_plugin: 1, connector: "calendar", recognize: { mcp_servers: ["google-calendar"] }, tier: "stateful",
    operations: ["tools/call:list_events", "tools/call:get_event"], read_only: ["tools/call:list_events", "tools/call:get_event"],
    serve: { command: [process.execPath, "serve.mjs"], protocol: "stdio", level: "tool" },
  }));
  const moment = join(root, "moment");
  await writeMomentBundle(moment, {
    manifest: { phoenix_moment: 1, id: "review", source: "snapshot", run: { capture: "review" }, mark: "review:0", clock: { time, timezone: "UTC" }, model: { id: "review/model" }, connectors: { "google-calendar": { surface: "mcp", tier: "recorded", origin: "captured", routes: ["transcript"], read_only: [{ op: "tools/call:list_events", source: "annotation" }] } }, resume: { recipe: "review", session: "data/session.jsonl", moment: "data/moment.json" } },
    files: new Map([
      ["check.draft.yaml", JSON.stringify({ phoenix_check: 1, samples: { base: 1, tiebreak: 0 }, scope: "continuation", expect: [{ final_text: { contains: "ok" } }] })],
      ["data/session.jsonl", "{}\n"],
      ["data/moment.json", JSON.stringify({ cut_lines: 1, prompt: "Read my calendar", model: { provider: "review", id: "model" }, loadout: {}, answers: [{ id: "list-1", connector: "google-calendar", op: "list_events", args: {}, result: { content: [{ type: "text", text: "[]" }] }, observed_at: time, before_cut: true }] })],
    ]),
  });
  const home = join(root, "home");
  await approveCheck(moment, { home, who: "review", reviewed: (await reviewDraft(moment)).digest });
  const runner = new Runner({ root: join(root, "runner"), ledger: ledgerPath(home) });
  const tree = { directory: harness, digest: await treeDigest(harness) };
  await assert.doesNotReject(runner.plan({
    moment, base: tree, candidate: tree,
    harness: { phoenix_harness: 1, name: "review", run: { resume: {} }, editable: ["AGENTS.md"] },
    recipe: join(recipe, "recipe.json"), image, start: "beginning",
    plugins: [{ name: "calendar", version: "1", directory: plugin, image }],
  }), "recognize.mcp_servers must work through public plan resolution, not only inside resumeAttempt");
});
