import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The working copy answering the nine tools of Google's hosted Calendar MCP server (the claude.ai connector), in the
// shapes that server was seen to answer with. Every value here is made up.
const plugin = fileURLToPath(new URL("../", import.meta.url));
const me = "fixture@example.invalid";
const text = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const seen = (op, args, value, at = "2026-11-16T10:00:00Z") => ({ op, args, result: text(value), observed_at: at });
const person = { email: me, self: true };
const time = (dateTime, timeZone = "America/Chicago") => ({ dateTime, timeZone });
const listedEvent = (id, start, end) => ({ conferenceData: {}, created: "2026-11-01T09:00:00Z", creator: person, end: time(end), eventType: "DEFAULT", htmlLink: `https://www.google.com/calendar/event?eid=${id}&ctz=America/Chicago`, id, organizer: person, start: time(start), status: "confirmed", summary: "[phoenix-test] standing", updated: "2026-11-01T09:00:00Z", useDefaultReminders: true });
const calendars = seen("list_calendars", {}, { calendars: [{ id: me, summary: me, timeZone: "America/Denver" }, { description: "Made up", id: "team@example.invalid", summary: "Team", timeZone: "America/Chicago" }] });
const day = { startTime: "2026-12-15T00:00:00", endTime: "2026-12-16T00:00:00", timeZone: "America/Chicago", orderBy: "startTime" };
const byKey = object => Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
const header = { accessRole: "owner", defaultReminders: [{ method: "popup", minutes: 30 }], summary: me, timeZone: "America/Denver", updated: "2026-11-15T12:00:00Z" };
const listed = seen("list_events", day, { ...header, events: [listedEvent("abcdefgh0001", "2026-12-15T08:15:00-06:00", "2026-12-15T08:40:00-06:00")] });

async function start(t, answers) {
  const root = await mkdtemp(join(plugin, ".hosted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "snapshot.json"), JSON.stringify({ answers }));
  const child = spawn(process.execPath, [join(plugin, "src/serve.mjs")], { cwd: plugin, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC" } });
  t.after(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} });
  const pending = new Map();
  let sequence = 0;
  createInterface({ input: child.stdout }).on("line", line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
  const request = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id, method, params }) + "\n"); });
  assert.equal((await request("initialize", { snapshot: join(root, "snapshot.json") })).status, "answer");
  return async (op, args, now = "2026-11-16T12:00:00.400Z") => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: op, arguments: args } })).toString("base64");
    const reply = await request("call", { op: `tools/call:${op}`, args, raw: { body }, now });
    if (reply.status !== "answer") return reply;
    const result = JSON.parse(Buffer.from(reply.value.body, "base64").toString()).result;
    return { status: "answer", isError: result.isError, text: result.content[0].text };
  };
}
const value = reply => { assert.equal(reply.status, "answer", JSON.stringify(reply)); assert.equal(reply.isError, false); return JSON.parse(reply.text); };

test("hosted: lists, reads and writes in the shapes Google's hosted server uses", { timeout: 30000 }, async t => {
  const call = await start(t, [calendars, listed]);
  assert.equal((await call("list_calendars", {})).text, JSON.stringify({ calendars: [{ id: me, summary: me, timeZone: "America/Denver" }, { description: "Made up", id: "team@example.invalid", summary: "Team", timeZone: "America/Chicago" }] }));
  assert.equal((await call("list_events", day)).text, JSON.stringify(byKey({ ...header, events: [listedEvent("abcdefgh0001", "2026-12-15T08:15:00-06:00", "2026-12-15T08:40:00-06:00")] })));

  const created = value(await call("create_event", { summary: "[phoenix-test] new", startTime: "2026-12-15T10:00:00", endTime: "2026-12-15T10:30:00", timeZone: "America/Chicago", notificationLevel: "NONE" }));
  assert.match(created.id, /^[a-v0-9]{26}$/);
  assert.deepEqual(Object.keys(created), ["availability", "conferenceData", "created", "creator", "end", "eventType", "htmlLink", "id", "organizer", "start", "status", "summary", "updated", "visibility"]);
  assert.deepEqual([created.start, created.end, created.created, created.updated, created.availability, created.visibility], [time("2026-12-15T16:00:00Z"), time("2026-12-15T16:30:00Z"), "2026-11-16T12:00:00Z", "2026-11-16T12:00:00Z", "AVAILABILITY_BUSY", "default"]);
  assert.equal(created.htmlLink, "https://calendar.google.com/calendar/event?eid=" + Buffer.from(`${created.id} ${me}`).toString("base64").replace(/=+$/, ""));

  const got = value(await call("get_event", { eventId: created.id }));
  assert.deepEqual(got, { conferenceData: {}, created: created.created, creator: person, end: time("2026-12-15T09:30:00-07:00"), eventType: "DEFAULT", htmlLink: created.htmlLink.replace("https://calendar.google.com/calendar/", "https://www.google.com/calendar/"), id: created.id, organizer: person, start: time("2026-12-15T09:00:00-07:00"), status: "confirmed", summary: "[phoenix-test] new", updated: created.updated, useDefaultReminders: true });

  const moved = value(await call("update_event", { eventId: created.id, startTime: "2026-12-15T11:00:00", timeZone: "America/Chicago", description: "moved" }, "2026-11-16T12:05:00Z"));
  assert.deepEqual([moved.start.dateTime, moved.end.dateTime, moved.description, moved.created, moved.updated], ["2026-12-15T17:00:00Z", "2026-12-15T17:30:00Z", "moved", created.created, "2026-11-16T12:05:00Z"]);

  const after = value(await call("list_events", day, "2026-11-16T12:06:00Z"));
  assert.deepEqual(after.events.map(e => [e.start.dateTime, e.htmlLink.endsWith("&ctz=America/Chicago")]), [["2026-12-15T08:15:00-06:00", true], ["2026-12-15T11:00:00-06:00", true]]);
  assert.equal(after.updated, "2026-11-16T12:05:00Z");

  assert.deepEqual(value(await call("delete_event", { eventId: created.id, notificationLevel: "NONE" }, "2026-11-16T12:07:00.200Z")), { id: created.id, status: "cancelled" });
  const emptied = value(await call("list_events", day, "2026-11-16T12:08:00Z"));
  assert.deepEqual(emptied.events.map(e => e.id), ["abcdefgh0001"]);
  assert.equal(emptied.updated, "2026-11-16T12:07:01Z");
  assert.equal((await call("get_event", { eventId: created.id })).status, "unsupported");
});

test("hosted: suggest_time returns the free stretches of the user's calendar, and {} when there are none", { timeout: 30000 }, async t => {
  const call = await start(t, [calendars, listed]);
  const ask = (startTime, endTime, durationMinutes) => call("suggest_time", { attendeeEmails: [me], startTime, endTime, timeZone: "America/Chicago", durationMinutes });
  const slot = (s, e, minutes) => ({ durationMinutes: minutes, end: time(e), endTime: e, start: time(s), startTime: s });
  assert.equal((await ask("2026-12-15T08:00:00", "2026-12-15T12:00:00", 30)).text, JSON.stringify({ timeSlots: [slot("2026-12-15T08:40:00-06:00", "2026-12-15T12:00:00-06:00", 200)] }));
  assert.equal((await ask("2026-12-15T08:00:00", "2026-12-15T08:35:00", 30)).text, "{}");
  assert.equal((await call("suggest_time", { attendeeEmails: ["someone@example.invalid"], startTime: "2026-12-15T09:00:00", endTime: "2026-12-15T12:00:00", timeZone: "America/Chicago" })).status, "unsupported");
  assert.equal((await ask("2026-12-16T09:00:00", "2026-12-16T12:00:00", 30)).status, "unsupported", "a day the copy never saw listed");
});

test("hosted: respond_to_event fails as Google does when the user is not an attendee", { timeout: 30000 }, async t => {
  const call = await start(t, [calendars, listed]);
  const reply = await call("respond_to_event", { eventId: "abcdefgh0001", responseStatus: "tentative" });
  assert.deepEqual(reply, { status: "answer", isError: true, text: "Cannot respond to event: The current user is not listed as an attendee on this event." });
  assert.equal((await call("respond_to_event", { eventId: "unknown00001", responseStatus: "accepted" })).status, "unsupported");
});

test("hosted: search_events repeats a search it saw, and stops once something it could newly match changed", { timeout: 30000 }, async t => {
  const call = await start(t, [calendars, listed, seen("search_events", { query: "standing" }, { events: [listedEvent("abcdefgh0001", "2026-12-15T08:15:00-06:00", "2026-12-15T08:40:00-06:00")] }, "2026-11-16T11:00:00Z")]);
  const found = value(await call("search_events", { query: "standing" }));
  assert.deepEqual(found.events.map(e => [e.id, e.start.dateTime, e.htmlLink.includes("ctz")]), [["abcdefgh0001", "2026-12-15T07:15:00-07:00", false]]);
  assert.equal((await call("search_events", { query: "other words" })).status, "unsupported");
  value(await call("create_event", { summary: "[phoenix-test] standing two", startTime: "2026-12-15T13:00:00", endTime: "2026-12-15T13:30:00", timeZone: "America/Chicago" }));
  assert.equal((await call("search_events", { query: "standing" })).status, "unsupported");
});

test("hosted: what the copy has not seen answered live stays unsupported", { timeout: 30000 }, async t => {
  const call = await start(t, [calendars, listed]);
  for (const [op, args] of [
    ["list_events", { ...day, startTime: "2026-12-14T00:00:00" }],
    ["list_events", { ...day, calendarId: "team@example.invalid" }],
    ["create_event", { summary: "x", startTime: "2026-12-15T10:00:00", endTime: "2026-12-15T10:30:00" }],
    ["create_event", { summary: "x", startTime: "2026-12-15T10:00:00", endTime: "2026-12-15T10:30:00", timeZone: "America/Chicago", attendees: [{ email: "guest@example.invalid" }] }],
    ["create_event", { summary: "x", startTime: "2026-12-15T10:00:00", endTime: "2026-12-15T10:30:00", timeZone: "America/Chicago", addGoogleMeetUrl: true }],
    ["update_event", { eventId: "unknown00001", summary: "x" }],
  ]) assert.equal((await call(op, args)).status, "unsupported", op + " " + JSON.stringify(args));
  const fresh = await start(t, []);
  assert.equal((await fresh("list_calendars", {})).status, "unsupported");
});
