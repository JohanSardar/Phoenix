import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const calendarId = "fixture@example.invalid";
const observed = (op, args, value) => ({ op, args, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
const event = (id, start, end, zone) => ({
  id, summary: "[phoenix-test] fixture", status: "confirmed", updated: "2026-11-15T00:00:00Z",
  start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone },
});

async function start(t, answers) {
  const root = await mkdtemp(join(plugin, ".review-b36ce74-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify({ answers, adapter: { calendarId, account: "normal" } }));
  const child = spawn(process.execPath, [join(plugin, "src/serve.mjs")], {
    cwd: plugin, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC" },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} });
  child.stderr.resume();
  const pending = new Map();
  const output = createInterface({ input: child.stdout });
  t.after(() => output.close());
  output.on("line", line => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  let sequence = 0;
  const request = (method, params) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id, method, params }) + "\n");
  });
  const initialized = await request("initialize", { snapshot });
  assert.equal(initialized.status, "answer", JSON.stringify(initialized));
  return async (op, args) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: op, arguments: args } })).toString("base64");
    return request("call", { surface: "mcp", layer: "agent", op: `tools/call:${op}`, args, raw: { body }, now: "2026-11-16T00:00:00Z" });
  };
}

function payload(reply) {
  assert.equal(reply.status, "answer", JSON.stringify(reply));
  const wire = JSON.parse(Buffer.from(reply.value.body, "base64").toString());
  assert.equal(wire.result?.isError ?? false, false, JSON.stringify(wire));
  return wire.result.structuredContent ?? JSON.parse(wire.result.content[0].text);
}

test("S1: adapter-only snapshot can list a subwindow of its already-known window", { timeout: 20000 }, async t => {
  const args = { timeMin: "2026-11-17T00:00:00-06:00", timeMax: "2026-11-18T00:00:00-06:00" };
  const ev = event("abcde", "2026-11-17T10:00:00-06:00", "2026-11-17T11:00:00-06:00", "America/Chicago");
  const call = await start(t, [observed("list_events", args, [ev])]);
  const events = payload(await call("list_events", { timeMin: "2026-11-17T09:00:00-06:00", timeMax: "2026-11-17T12:00:00-06:00" }));
  assert.deepEqual(events.map(e => e.id), [ev.id]);
});

test("S2: fitting the adapter calendar must not poison a known IANA zone", { timeout: 20000 }, async t => {
  const knownId = "bogota@example.invalid";
  const winter = event("abcde", "2026-11-17T10:00:00-05:00", "2026-11-17T11:00:00-05:00", "America/New_York");
  const summer = event("bcdef", "2026-07-01T10:00:00-05:00", "2026-07-01T11:00:00-05:00", "America/Bogota");
  const call = await start(t, [
    observed("list-calendars", {}, { calendars: [{ id: knownId, summary: "Fixture Bogota", timeZone: "America/Bogota", accessRole: "owner" }] }),
    observed("get_event", { id: winter.id }, winter),
    observed("get-event", { calendarId: knownId, eventId: summer.id }, { event: summer }),
  ]);
  const args = { calendarId: knownId, eventId: summer.id, account: "normal" };
  assert.equal(payload(await call("get-event", args)).event.start.dateTime, summer.start.dateTime);
  assert.equal(payload(await call("get_event", { id: winter.id })).id, winter.id);
  assert.equal(payload(await call("get-event", args)).event.start.dateTime, summer.start.dateTime);
});
