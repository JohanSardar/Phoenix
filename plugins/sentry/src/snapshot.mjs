#!/usr/bin/env node
// A stdio MCP server for the moment's snapshot. It is Sentry's own MCP server, reading the real Sentry with GET only:
// route.mjs refuses every other method before it leaves this machine.
// Each tool answer carries the Sentry API replies behind it in _meta, so the working copy can answer from them later.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { token } from "./login.mjs";
import { startSentryServer } from "./server.mjs";

const scratch = mkdtempSync(join(tmpdir(), "phoenix-sentry-snapshot-"));
const log = join(scratch, "api.jsonl");
writeFileSync(log, "");
const server = await startSentryServer({ mode: "snapshot", token: token(), log });
let read = 0;
let tail = Promise.resolve();
const reply = message => process.stdout.write(JSON.stringify(message) + "\n");

async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") return reply({ jsonrpc: "2.0", id: message.id, result: server.initialized });
  const answer = await server.request(message.method, message.params);
  const { id: _, ...rest } = answer;
  if (message.method === "tools/call" && rest.result) {
    const text = readFileSync(log, "utf8");
    const api = text.slice(read).split("\n").filter(Boolean).map(line => JSON.parse(line));
    read = text.length;
    rest.result = { ...rest.result, _meta: { ...rest.result._meta, "phoenix/sentry-api": api } };
  }
  reply({ ...rest, id: message.id });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  tail = tail.then(() => handle(message)).catch(error => {
    if (message.id !== undefined) reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  });
});
lines.on("close", async () => { await tail; await server.close(); rmSync(scratch, { recursive: true, force: true }); });
