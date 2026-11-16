import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("adding native MCP preserves Codex's effective model-provider launch arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "ozi-codex-args-"));
  try {
    const source = join(root, "source"), home = join(root, "capture");
    mkdirSync(join(source, "userdata"), { recursive: true });
    writeFileSync(join(source, "userdata/settings.json"), JSON.stringify({
      providerInstances: {
        codexNative: {
          driver: "codex", config: { setupMode: "existing", launchArgs: "" },
          environment: [{ name: "OZI_CODEX_LAUNCH_ARGS", value: "--config model_provider=chosen-provider", sensitive: false }],
        },
      },
    }));
    const mcp = join(root, "mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { scratch: { command: "node", args: [] } } }));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./launch.mjs", import.meta.url)),
      "--source-home", source, "--home", home, "--instance", "codexNative", "--driver", "codex",
      "--mcp-file", mcp, "--", process.execPath, "-e", "", "--",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(readFileSync(join(home, "userdata/settings.json"), "utf8"));
    const effective = settings.providerInstances.codexNative.environment.find(entry => entry.name === "OZI_CODEX_LAUNCH_ARGS").value;
    assert.ok(effective.includes("model_provider=chosen-provider"), effective);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
