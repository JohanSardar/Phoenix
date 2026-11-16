import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Codex receives the original MCP server name from the native launch overlay", () => {
  const root = mkdtempSync(join(tmpdir(), "ozi-codex-mcp-name-"));
  try {
    const source = join(root, "source"), home = join(root, "capture");
    mkdirSync(join(source, "userdata"), { recursive: true });
    writeFileSync(join(source, "userdata/settings.json"), JSON.stringify({
      providerInstances: { codexNative: { driver: "codex", config: { setupMode: "existing" } } },
    }));
    const mcp = join(root, "mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { "phoenix-proof": { command: "node", args: [] } } }));
    const launch = spawnSync(process.execPath, [
      fileURLToPath(new URL("./launch.mjs", import.meta.url)),
      "--source-home", source, "--home", home, "--instance", "codexNative", "--driver", "codex",
      "--mcp-file", mcp, "--", process.execPath, "-e", "", "--",
    ], { encoding: "utf8" });
    assert.equal(launch.status, 0, launch.stderr);
    const settings = JSON.parse(readFileSync(join(home, "userdata/settings.json"), "utf8"));
    const args = settings.providerInstances.codexNative.config.launchArgs;
    const override = /^-c '(.+)'$/.exec(args)?.[1];
    assert.ok(override, args);
    mkdirSync(join(root, "codex"));
    const listed = spawnSync("codex", ["-c", override, "mcp", "list", "--json"], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: join(root, "codex") },
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map(server => server.name), ["phoenix-proof"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
