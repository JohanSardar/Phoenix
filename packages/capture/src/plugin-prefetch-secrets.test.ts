import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPlugin } from "@phoenix/plugin-host";
import { BlobStore, createCapture, digest, readCapture } from "@phoenix/store";
import { capturePlugin } from "./index.ts";

test("S1: capture sidecar strips secret fields inside recorded response bodies", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-prefetch-secrets-"));
  const marker = "synthetic-test-only-credential";
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "event-1", password: marker }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const target = `http://127.0.0.1:${address.port}/events`;
    const op = `GET 127.0.0.1:${address.port}/events`;
    await writeFile(join(scratch, "capture.mjs"), `
      import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        const value = request.method === "initialize" ? {} : request.params.phase === "plan"
          ? { calls: [{ op: ${JSON.stringify(op)}, args: { query: "", body: null } }] }
          : { collections: [{ entity: "event", complete: false }] };
        console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
      }
    `);
    await writeFile(join(scratch, "phoenix-plugin.json"), JSON.stringify({
      phoenix_plugin: 1, connector: "example", recognize: { hosts: ["127.0.0.1"] },
      tier: "recorded", operations: [op], read_only: [op],
      capture: { command: [process.execPath, "capture.mjs"], protocol: "stdio" },
    }));
    const root = join(scratch, "capture");
    await createCapture(root, {
      capture: "prefetch-secrets", harness: { name: "example", tree: digest(Buffer.from("proof")) },
      recipe: { name: "generic", version: "1" }, routes: [],
      started_at: new Date().toISOString(), boot_id: "proof",
    });
    const plugin = await readPlugin(join(scratch, "phoenix-plugin.json"));
    await capturePlugin({ root, home: join(scratch, "home"), connector: "example", plugin, target: { surface: "http", url: target } });
    const capture = await readCapture(root);
    const event = capture.allEvents.find(event => event.kind === "prefetch");
    assert.ok(event?.body && "blob" in event.body);
    const stored = JSON.parse(Buffer.from(await new BlobStore(root).get(event.body.blob)).toString());
    const response = JSON.parse(stored.response.body);
    assert.equal(response.password === marker, false, "prefetch response JSON secret fields must be stripped before persistence");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
