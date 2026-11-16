import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("import accepts Ozi's own OpenCode native log envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "ozi-native-opencode-"));
  try {
    const observedAt = "2026-11-15T12:00:00.000Z";
    const value = {
      observedAt,
      event: {
        id: "source-event", kind: "protocol", protocol: "opencode-sdk.sse", provider: "opencode",
        providerInstanceId: "opencode", providerSessionId: "provider-session",
        createdAt: observedAt, threadId: "source-thread",
        payload: {
          direction: "incoming", messageKind: "notification", method: "session.idle",
          payload: { valueType: "object", fieldCount: 1 },
        },
      },
    };
    const source = join(root, "events.source-thread.log");
    writeFileSync(source, `[${observedAt}] NTIVE: ${JSON.stringify(value)}\n`);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../../packages/cli/src/import.ts", import.meta.url)),
      "--recipe", fileURLToPath(new URL("./recipe.yaml", import.meta.url)),
      "--home", join(root, "phoenix"), "--capture", "native-opencode", source,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout || result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
