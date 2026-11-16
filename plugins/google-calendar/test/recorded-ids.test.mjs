import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

// When the engine runs a recorded write against the copy, it sends the recorded answer with the call. The created event
// keeps the id the agent was given, so later calls by that id reach the copy. Both ways in: Google's hosted server (the
// claude.ai connector) and the local server. Every value here is made up.
const plugin = fileURLToPath(new URL("../", import.meta.url));
const me = "fixture@example.invalid";
const text = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const seen = (op, args, value) => ({ op, args, result: text(value), observed_at: "2026-11-16T10:00:00Z" });
const wire = message => Buffer.from(JSON.stringify(message)).toString("base64");

async function start(t, answers) {
  const root = await mkdtemp(join(plugin, ".recorded-ids-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "snapshot.json"), JSON.stringify({ answers }));
  const child = spawn(process.execPath, [join(plugin, "src/serve.mjs")], { cwd: plugin, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC" } });
  t.after(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} });
  const pending = new Map();
  let sequence = 0;
  createInterface({ input: child.stdout }).on("line", line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
  const request = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id, method, params }) + "\n"); });
  assert.equal((await request("initialize", { snapshot: join(root, "snapshot.json") })).status, "answer");
  return async (op, args, answer) => {
    const params = { op: `tools/call:${op}`, args, raw: { body: wire({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: op, arguments: args } }) }, now: "2026-11-16T12:00:00Z" };
    if (answer) params.recorded = { body: wire({ jsonrpc: "2.0", id: 9, result: text(answer) }) };
    const reply = await request("call", params);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    const result = JSON.parse(Buffer.from(reply.value.body, "base64").toString()).result;
    return { isError: !!result.isError, value: JSON.parse(result.content[0].text) };
  };
}

test("hosted: after a recorded create_event, get, update and delete by the recorded id reach the copy", { timeout: 30000 }, async t => {
  const person = { email: me, self: true };
  const calendars = seen("list_calendars", {}, { calendars: [{ id: me, summary: me, timeZone: "America/Denver" }] });
  const day = { startTime: "2026-12-15T00:00:00", endTime: "2026-12-16T00:00:00", timeZone: "America/Chicago", orderBy: "startTime" };
  const listed = seen("list_events", day, { accessRole: "owner", defaultReminders: [], summary: me, timeZone: "America/Denver", updated: "2026-11-15T12:00:00Z" });
  const args = { summary: "[phoenix-test] recorded", startTime: "2026-12-15T10:00:00", endTime: "2026-12-15T10:30:00", timeZone: "America/Chicago" };
  const recorded = { availability: "AVAILABILITY_BUSY", conferenceData: {}, created: "2026-11-16T12:00:00Z", creator: person, end: { dateTime: "2026-12-15T16:30:00Z", timeZone: "America/Chicago" }, eventType: "DEFAULT", htmlLink: "https://calendar.google.com/calendar/event?eid=recorded", id: "recorded0001", organizer: person, start: { dateTime: "2026-12-15T16:00:00Z", timeZone: "America/Chicago" }, status: "confirmed", summary: args.summary, updated: "2026-11-16T12:00:00Z", visibility: "default" };
  const call = await start(t, [calendars, listed]);
  assert.equal((await call("create_event", args, recorded)).value.id, recorded.id);
  const got = await call("get_event", { eventId: recorded.id });
  assert.deepEqual([got.isError, got.value.id, got.value.start.dateTime], [false, recorded.id, "2026-12-15T09:00:00-07:00"]);
  const moved = await call("update_event", { eventId: recorded.id, startTime: "2026-12-15T11:00:00", timeZone: "America/Chicago" });
  assert.deepEqual([moved.isError, moved.value.id, moved.value.start.dateTime], [false, recorded.id, "2026-12-15T17:00:00Z"]);
  assert.deepEqual(await call("delete_event", { eventId: recorded.id }), { isError: false, value: { id: recorded.id, status: "cancelled" } });
  assert.notEqual((await call("create_event", args)).value.id, recorded.id);
});

test("local server: after a recorded create-event, get, update and delete by the recorded id reach the copy", { timeout: 30000 }, async t => {
  const calendar = seen("list-calendars", {}, { calendars: [{ id: me, summary: "Fixture", primary: true, timeZone: "UTC", accessRole: "owner", defaultReminders: [] }], totalCount: 1 });
  const window = { calendarId: me, timeMin: "2026-12-15T00:00:00Z", timeMax: "2026-12-16T00:00:00Z", timeZone: "UTC" };
  const listed = seen("list-events", window, { events: [], totalCount: 0 });
  const args = { calendarId: me, summary: "[phoenix-test] recorded", start: "2026-12-15T10:00:00Z", end: "2026-12-15T10:30:00Z", sendUpdates: "none" };
  const event = { kind: "calendar#event", id: "recorded0002", status: "confirmed", summary: args.summary, updated: "2026-11-16T12:00:00.000Z", start: { dateTime: "2026-12-15T10:00:00Z" }, end: { dateTime: "2026-12-15T10:30:00Z" }, calendarId: me, accountId: "normal" };
  const call = await start(t, [calendar, listed]);
  assert.equal((await call("create-event", args, { event })).value.event.id, event.id);
  const got = await call("get-event", { calendarId: me, eventId: event.id });
  assert.deepEqual([got.isError, got.value.event.id, got.value.event.summary], [false, event.id, args.summary]);
  const moved = await call("update-event", { calendarId: me, eventId: event.id, start: "2026-12-15T11:00:00Z", end: "2026-12-15T11:30:00Z", sendUpdates: "none" });
  assert.deepEqual([moved.isError, moved.value.event.id, moved.value.event.start.dateTime], [false, event.id, "2026-12-15T11:00:00Z"]);
  const deleted = await call("delete-event", { calendarId: me, eventId: event.id, sendUpdates: "none" });
  assert.deepEqual([deleted.isError, deleted.value.success], [false, true]);
});
