import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("launcher refuses an API key that remains in the source Ozi secret store", () => {
  const root = mkdtempSync(join(tmpdir(), "ozi-redacted-"));
  try {
    const source = join(root, "source");
    mkdirSync(join(source, "userdata"), { recursive: true });
    writeFileSync(join(source, "userdata/settings.json"), JSON.stringify({
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent", config: {},
          environment: [{ name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true }],
        },
      },
    }));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./launch.mjs", import.meta.url)),
      "--source-home", source, "--home", join(root, "capture"),
      "--instance", "claudeAgent", "--driver", "claudeAgent",
      "--", process.execPath, "-e", "", "--",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0,
      "Do not start a capture home with an unresolved native API key and potentially change its login/billing mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
