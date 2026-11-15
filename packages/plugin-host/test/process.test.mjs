import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPlugin, startPlugin } from "../src/index.ts";

test("a fatal protocol error rejects an already pending HTTP call", async () => {
  const directory = await mkdtemp(join(import.meta.dirname, "scratch-s2-"));
  let session;
  try {
    await writeFile(join(directory, "plugin.mjs"), `
      import { createServer } from "node:http";
      let held;
      const server = createServer((req, res) => {
        if (req.url === "/release") {
          held.res.end(JSON.stringify({ ...held.message, status: "answer", value: "late success" }));
          res.end("released");
          return;
        }
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          const message = JSON.parse(body);
          if (message.method === "initialize") {
            res.end(JSON.stringify({ ...message, status: "answer", value: server.address().port }));
          } else {
            held = { res, message };
            process.stdout.write('{"phoenix_plugin":99}\\n', () => process.stderr.write("CORRUPT_SENT\\n"));
          }
        });
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({
        phoenix_plugin: 1, ready: { url: "http://127.0.0.1:" + server.address().port + "/plugin" }
      }) + "\\n"));
    `);
    await writeFile(join(directory, "phoenix-plugin.json"), JSON.stringify({
      phoenix_plugin: 1,
      connector: "review-http",
      recognize: {},
      tier: "recorded",
      operations: ["read"],
      read_only: ["read"],
      capture: { protocol: "http", command: [process.execPath, "plugin.mjs"] },
    }));
    let corrupt;
    const corrupted = new Promise(resolve => { corrupt = resolve; });
    session = await startPlugin(await readPlugin(join(directory, "phoenix-plugin.json")), "capture", {
      context: {},
      timeoutMs: 5000,
      onStderr: chunk => { if (chunk.toString().includes("CORRUPT_SENT")) corrupt(); },
    });
    const initialized = await session.request("initialize", {});
    const pending = session.request("call", { op: "read", args: {} });
    pending.catch(() => {});
    await corrupted;
    await new Promise(setImmediate);
    await assert.rejects(session.request("call", { op: "not-read-only" }), /Unsupported plugin protocol version/);
    console.log("host has observed the fatal protocol error");
    await fetch("http://127.0.0.1:" + initialized.value + "/release");
    await assert.rejects(pending.then(result => {
      console.log("pending HTTP call resolved after fatal error:", result);
      return result;
    }), /Unsupported plugin protocol version/);
  } finally {
    await session?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
