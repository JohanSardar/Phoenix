import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const calendarId = "fixture@example.invalid";
const window = { calendarId, timeMin: "2026-11-16T00:00:00Z", timeMax: "2026-11-18T00:00:00Z", timeZone: "UTC" };
const observed = (op, args, value) => ({ op, args, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
const calendar = observed("list-calendars", {}, { calendars: [{ id: calendarId, summary: "Fixture", primary: true, timeZone: "UTC", accessRole: "owner", defaultReminders: [] }], totalCount: 1 });
const event = (id = "abcde") => ({
  id, summary: "[phoenix-test] fixture", status: "confirmed", updated: "2026-11-15T00:00:00Z",
  start: { dateTime: "2026-11-16T10:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-11-16T11:00:00Z", timeZone: "UTC" },
  calendarId, accountId: "normal", iCalUID: `${id}@google.com`,
});
const listed = (events, args = window) => observed("list-events", args, { events, totalCount: events.length });
const master = { ...event(), recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] };
const instances = [16, 17].map(day => ({ ...event(`abcde_202611${day}T100000Z`),
  start: { dateTime: `2026-11-${day}T10:00:00Z`, timeZone: "UTC" },
  end: { dateTime: `2026-11-${day}T11:00:00Z`, timeZone: "UTC" },
  recurringEventId: "abcde", iCalUID: master.iCalUID, originalStartTime: { dateTime: `2026-11-${day}T10:00:00Z`, timeZone: "UTC" },
}));

async function start(t, answers) {
  const root = await mkdtemp(join(plugin, ".review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify({ answers: [calendar, ...answers] }));
  const child = spawn(process.execPath, [join(plugin, "src/serve.mjs")], {
    cwd: plugin, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC" },
  });
  t.after(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} });
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const reply = JSON.parse(line);
    const resolve = pending.get(reply.id);
    pending.delete(reply.id);
    resolve?.(reply);
  });
  const request = (method, params) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id, method, params }) + "\n");
  });
  const initialized = await request("initialize", { snapshot });
  assert.equal(initialized.status, "answer", JSON.stringify(initialized) + stderr);
  return async (op, args) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: op, arguments: args } })).toString("base64");
    const reply = await request("call", { surface: "mcp", layer: "agent", op: `tools/call:${op}`, args, raw: { body }, now: "2026-11-16T00:00:00Z" });
    if (reply.status === "answer") reply.wire = JSON.parse(Buffer.from(reply.value.body, "base64").toString());
    return reply;
  };
}

function payload(reply) {
  assert.equal(reply.status, "answer", JSON.stringify(reply));
  assert.equal(reply.wire.result?.isError ?? false, false, JSON.stringify(reply.wire));
  return reply.wire.result.structuredContent ?? JSON.parse(reply.wire.result.content[0].text);
}

test("S1: a capped cocal list does not prove the whole window is known", { timeout: 20000 }, async t => {
  const page = Array.from({ length: 250 }, (_, i) => event(`a${String(i).padStart(4, "0")}`));
  const call = await start(t, [listed(page)]);
  const reply = await call("search-events", { ...window, query: "unseen-event" });
  assert.equal(reply.status, "unsupported", `A 250-item first page cannot establish absence: ${JSON.stringify(reply.wire ?? reply)}`);
});

test("S2: a field-masked list cannot seed a full get-event answer", { timeout: 20000 }, async t => {
  const partial = event();
  delete partial.iCalUID;
  const call = await start(t, [listed([partial], { ...window, fields: ["updated"] })]);
  const reply = await call("get-event", { calendarId, eventId: partial.id });
  assert.equal(reply.status, "unsupported", `Description and other omitted fields are unknown: ${JSON.stringify(reply.wire ?? reply)}`);
});

test("S3: extending a series updates previously observed ordinary instances", { timeout: 20000 }, async t => {
  const call = await start(t, [listed(instances), observed("get-event", { calendarId, eventId: master.id }, { event: master })]);
  payload(await call("update-event", { calendarId, eventId: master.id, modificationScope: "all", end: "2026-11-16T12:00:00Z", checkConflicts: false, sendUpdates: "none" }));
  const got = payload(await call("list-events", window));
  assert.deepEqual(got.events.map(e => e.end.dateTime), ["2026-11-16T12:00:00Z", "2026-11-17T12:00:00Z"]);
});

test("S4: an occurrence moved into an earlier window remains listed", { timeout: 20000 }, async t => {
  const call = await start(t, [listed(instances), observed("get-event", { calendarId, eventId: master.id }, { event: master })]);
  const moved = payload(await call("update-event", { calendarId, eventId: master.id, modificationScope: "thisEventOnly", originalStartTime: "2026-11-17T10:00:00Z", start: "2026-11-16T15:00:00Z", end: "2026-11-16T16:00:00Z", checkConflicts: false, sendUpdates: "none" })).event;
  assert.equal(moved.start.dateTime, "2026-11-16T15:00:00Z");
  const got = payload(await call("list-events", { ...window, timeMax: "2026-11-17T00:00:00Z" }));
  assert.equal(got.events.find(e => e.id === moved.id)?.start.dateTime, "2026-11-16T15:00:00Z");
});

test("S5: freebusy must not return pre-write cached blocks", { timeout: 20000 }, async t => {
  const busyArgs = { timeMin: window.timeMin, timeMax: window.timeMax, timeZone: "UTC", calendars: [{ id: calendarId }] };
  const call = await start(t, [observed("get-freebusy", busyArgs, { timeMin: window.timeMin, timeMax: window.timeMax, calendars: { [calendarId]: { busy: [] } } })]);
  const created = payload(await call("create-events", { calendarId, timeZone: "UTC", sendUpdates: "none", events: [{ summary: "[phoenix-test] busy", start: "2026-11-16T10:00:00Z", end: "2026-11-16T11:00:00Z" }] }));
  assert.equal(created.totalCreated, 1);
  const reply = await call("get-freebusy", busyArgs);
  if (reply.status === "unsupported") return;
  assert.deepEqual(payload(reply).calendars[calendarId].busy, [{ start: "2026-11-16T10:00:00Z", end: "2026-11-16T11:00:00Z" }]);
});

test("S6: creating a weekly series without an end date is supported", { timeout: 20000 }, async t => {
  const call = await start(t, []);
  const reply = await call("create-events", { calendarId, timeZone: "UTC", sendUpdates: "none", events: [{ summary: "[phoenix-test] weekly", start: "2026-11-16T10:00:00Z", end: "2026-11-16T11:00:00Z", recurrence: ["RRULE:FREQ=WEEKLY"] }] });
  assert.equal(payload(reply).totalCreated, 1);
});
