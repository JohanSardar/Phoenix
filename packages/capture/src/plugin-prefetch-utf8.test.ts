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

test("S4: prefetch preserves a UTF-8 response's leading byte-order mark", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-prefetch-utf8-"));
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("example data")]);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(bytes);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/data`;
    const op = `GET 127.0.0.1:${address.port}/data`;
    const command = `
      import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        const value = request.method === "initialize" ? {} : request.params.phase === "plan"
          ? { calls: [{ op: ${JSON.stringify(op)}, args: { query: "", body: null } }] }
          : { collections: [] };
        console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
      }
    `;
    await writeFile(join(scratch, "phoenix-plugin.json"), JSON.stringify({
      phoenix_plugin: 1, connector: "files", recognize: { hosts: ["127.0.0.1"] },
      tier: "recorded", operations: [op], read_only: [op],
      capture: { command: [process.execPath, "--input-type=module", "-e", command], protocol: "stdio" },
    }));
    const root = join(scratch, "capture");
    await createCapture(root, { capture: "prefetch-utf8", harness: { name: "files", tree: digest(Buffer.from("proof")) },
      recipe: { name: "generic", version: "1" }, routes: [], started_at: new Date().toISOString(), boot_id: "proof" });
    const plugin = await readPlugin(join(scratch, "phoenix-plugin.json"));
    await capturePlugin({ root, home: join(scratch, "home"), connector: "files", plugin, target: { surface: "http", url } });
    const capture = await readCapture(root);
    const event = capture.allEvents.find(event => event.kind === "prefetch");
    assert.ok(event?.body && "blob" in event.body);
    const stored = JSON.parse(Buffer.from(await new BlobStore(root).get(event.body.blob)).toString());
    const replayBytes = Buffer.from(stored.response.body, stored.response.body_encoding === "base64" ? "base64" : "utf8");
    assert.deepEqual(replayBytes, bytes, "UTF-8 serialization must preserve response bytes when no secret was replaced");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
