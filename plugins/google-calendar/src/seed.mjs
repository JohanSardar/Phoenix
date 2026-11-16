import { naiveToMs, parseInstant, validZone } from "./time.mjs";

export const COCAL = new Set(["list-calendars", "list-events", "search-events", "get-event", "list-colors", "create-event", "create-events", "update-event", "delete-event", "get-freebusy", "get-current-time", "respond-to-event", "manage-accounts"]);
export const GOOGLE_MCP = new Set(["list_calendars", "list_events", "get_event", "search_events", "suggest_time", "create_event", "update_event", "delete_event", "respond_to_event"]);

// Which way in a call came from: the local server (cocal), Phoenix's own adapter over it, or Google's hosted MCP server (claude.ai).
export function dialect(op, args = {}) {
  if (COCAL.has(op)) return "cocal";
  if (op === "move_event") return "adapter";
  if (op === "list_events" && ("timeMin" in args || "timeMax" in args)) return "adapter";
  if (op === "get_event" && "id" in args && !("eventId" in args)) return "adapter";
  if (GOOGLE_MCP.has(op)) return "google";
  return undefined;
}

export function payload(result) {
  if (!result || result.isError) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.length === 1 && result.content[0].type === "text" ? result.content[0].text : undefined;
  try { return text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
}

const ids = value => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) { try { return JSON.parse(value); } catch {} }
  return value === undefined ? ["primary"] : [value];
};

function bound(copy, value, zoneArg, calId) {
  if (typeof value !== "string") return NaN;
  const direct = parseInstant(value);
  if (Number.isFinite(direct)) return direct;
  const zone = zoneArg ?? copy.calendars.get(copy.calId(calId))?.entry?.timeZone;
  return zone && validZone(zone) ? naiveToMs(value, zone) : NaN;
}

function resolveName(copy, name) {
  if (name === "primary") return name;
  for (const cal of copy.calendars.values()) if (cal.entry && (cal.entry.id === name || cal.entry.summary === name || cal.entry.summaryOverride === name)) return cal.entry.id;
  return name;
}

// Turns one answer the session saw into state of the copy. Unrecognized or failed answers teach nothing.
export function learn(copy, answer, adapter = { calendarId: "primary" }) {
  const { op, args = {} } = answer;
  const kind = dialect(op, args);
  const value = payload(answer.result);
  if (value === undefined) return;
  if (kind === "cocal") return learnCocal(copy, op, args, value);
  if (kind === "adapter") return learnAdapter(copy, op, args, value, adapter);
}

function learnList(copy, calId, events, a, b, whole) {
  const cal = copy.cal(calId);
  if (whole && Number.isFinite(a) && Number.isFinite(b) && b > a) {
    copy.dropWindowEvents(cal, a, b, new Set(events.map(e => e.id)));
    copy.addWindow(cal, a, b);
  }
  for (const ev of events) if (ev?.id && ev.updated) copy.putEvent(calId, ev);
}

function learnCocal(copy, op, args, value) {
  if (op === "list-calendars") {
    for (const entry of value.calendars ?? []) copy.putEntry(entry);
    if (!args.account || typeof args.account === "string") copy.listComplete = true;
    return;
  }
  if (op === "manage-accounts") {
    const primary = value.accounts?.[0]?.primary_calendar;
    if (primary?.id) copy.setPrimary(primary.id);
    return;
  }
  if (op === "list-events" || op === "search-events") {
    const whole = op === "list-events" && !args.fields && !args.privateExtendedProperty?.length && !args.sharedExtendedProperty?.length;
    const byCal = new Map();
    for (const name of ids(args.calendarId)) byCal.set(resolveName(copy, name), []);
    for (const ev of value.events ?? []) {
      const calId = resolveName(copy, ev.calendarId ?? ids(args.calendarId)[0]);
      if (!byCal.has(calId)) byCal.set(calId, []);
      byCal.get(calId).push(ev);
    }
    for (const [calId, events] of byCal) learnList(copy, calId, events, bound(copy, args.timeMin, args.timeZone, calId), bound(copy, args.timeMax, args.timeZone, calId), whole);
    return;
  }
  if (op === "get-event" || op === "create-event" || op === "update-event" || op === "respond-to-event") {
    const calId = resolveName(copy, args.calendarId ?? "primary");
    if (op === "update-event" && args.modificationScope === "thisAndFollowing") copy.cal(calId).events.delete(args.eventId);
    if (value.event?.id && value.event.updated && !args.fields) copy.putEvent(value.event.calendarId ? resolveName(copy, value.event.calendarId) : calId, value.event);
    return;
  }
  if (op === "create-events") {
    for (const ev of value.created ?? []) if (ev?.id && ev.updated && ev.iCalUID) copy.putEvent(resolveName(copy, ev.calendarId ?? args.calendarId ?? "primary"), ev);
    return;
  }
  if (op === "delete-event" && value.success) {
    const cal = copy.cal(resolveName(copy, args.calendarId ?? "primary"));
    const ev = cal.events.get(args.eventId);
    if (ev) cal.events.set(ev.id, { ...ev, status: "cancelled", sequence: (ev.sequence ?? 0) + 1 });
    return;
  }
  if (op === "get-freebusy") {
    for (const [key, entry] of Object.entries(value.calendars ?? {})) {
      if (!Array.isArray(entry?.busy) || entry.errors?.length) continue;
      const calId = resolveName(copy, key);
      const a = bound(copy, args.timeMin, args.timeZone, calId), b = bound(copy, args.timeMax, args.timeZone, calId);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      copy.cal(calId).busy.push({ a, b, blocks: entry.busy.map(x => [parseInstant(x.start), parseInstant(x.end)]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)) });
    }
  }
}

function learnAdapter(copy, op, args, value, adapter) {
  const calId = adapter.calendarId;
  if (op === "list_events" && Array.isArray(value)) return learnList(copy, calId, value, parseInstant(args.timeMin), parseInstant(args.timeMax), !args.privateExtendedProperty?.length);
  if ((op === "get_event" || op === "move_event") && value?.id && value.updated) copy.putEvent(calId, value);
}

export function seedAll(copy, answers, adapter) {
  const usable = answers.filter(a => a.before_cut !== false).map((a, i) => [a, i]).sort((x, y) => (Date.parse(x[0].observed_at ?? "") || 0) - (Date.parse(y[0].observed_at ?? "") || 0) || x[1] - y[1]).map(x => x[0]);
  // Calendar lists first: time windows need each calendar's time zone.
  for (const a of usable) if (["list-calendars", "manage-accounts"].includes(a.op)) learn(copy, a, adapter);
  for (const a of usable) if (!["list-calendars", "manage-accounts"].includes(a.op)) learn(copy, a, adapter);
}
