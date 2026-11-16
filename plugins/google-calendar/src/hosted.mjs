import { randomBytes } from "node:crypto";
import { Unknown, formatInZone, naiveToMs, parseInstant, validZone } from "./time.mjs";

// Google's hosted Calendar MCP server, the claude.ai Google Calendar connector, answered from the same in-memory copy.
// Its answers are compact JSON with sorted keys. It shows events two ways, both seen live:
// - after a write (create_event, update_event): times in UTC with a trailing Z, a calendar.google.com link, availability
//   and visibility, and no reminders;
// - when reading (get_event, list_events, search_events): times in the calendar's zone (or list_events' timeZone),
//   a www.google.com link (list_events adds &ctz=<timeZone>), useDefaultReminders, and no availability or visibility.
// Empty lists are left out, so a search with no match is {}. Anything the copy has not seen answered live is a gap.

export const TOOLS = ["list_calendars", "list_events", "get_event", "search_events", "suggest_time", "create_event", "update_event", "delete_event", "respond_to_event"];
const NOT_ATTENDEE = "Cannot respond to event: The current user is not listed as an attendee on this event.";
const LISTED_TYPES = ["DEFAULT", "OUT_OF_OFFICE", "FOCUS_TIME", "FROM_GMAIL"];
const B32 = "0123456789abcdefghijklmnopqrstuv";
const READ_LINK = "https://www.google.com/calendar/event?eid=";
const WRITE_LINK = "https://calendar.google.com/calendar/event?eid=";

const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const seconds = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const upSeconds = ms => seconds(Math.ceil(ms / 1000) * 1000);
const known = (args, allowed) => { for (const [key, value] of Object.entries(args)) if (value !== undefined && !allowed.includes(key)) throw new Unknown(`the copy has not seen how Google's hosted server handles ${key}`); };

// Turns an event as the hosted server showed it into what the copy keeps: the reading view, plus availability and
// visibility when a write answer showed them.
export function keep(event, before) {
  const { htmlLink, ...rest } = event;
  const kept = { ...before, ...rest, htmlLink: String(htmlLink ?? before?.htmlLink ?? "").replace(WRITE_LINK, READ_LINK).replace(/&ctz=.*$/, "") };
  if (!("useDefaultReminders" in kept) && !kept.overrideReminders) kept.useDefaultReminders = true;
  return kept;
}

export class Hosted {
  constructor(copy) {
    this.copy = copy;
    this.order = undefined;
    this.searches = [];
    this.suggested = [];
    this.changes = [];
  }

  gap(why) { this.copy.gap(why); }
  cal(calendarId) {
    if (calendarId !== undefined && calendarId !== "primary" && !this.copy.calendars.get(calendarId)?.entry) this.gap(`the copy does not know calendar ${calendarId}`);
    return this.copy.cal(calendarId ?? "primary");
  }
  zone(cal) { return cal.entry?.timeZone ?? cal.hosted?.timeZone ?? this.gap(`the copy does not know the time zone of calendar ${cal.id}`); }
  me() { return this.copy.primary ?? this.gap("the copy does not know whose calendar this is"); }
  time(value, zone, what) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) this.gap(`the copy has only seen local times without an offset as ${what}`);
    if (!zone || !validZone(zone)) this.gap(`the copy has only seen ${what} with a known IANA time zone`);
    return naiveToMs(value, zone);
  }
  event(cal, eventId, write = true) {
    const event = cal.events.get(eventId);
    if (!event) this.gap(`the copy has not seen event ${eventId} in ${cal.id}`);
    if (event.status === "cancelled") this.gap(`the copy has not seen how the hosted server answers for deleted event ${eventId}`);
    if (write && (event.recurringEventId || event.recurrence)) this.gap(`the copy has not seen the hosted server change a repeating event`);
    return event;
  }
  wrote(cal, ms, event) {
    if (cal.hosted) cal.hosted.updated = upSeconds(ms);
    this.changes.push({ id: event.id, at: ms, created: Date.parse(event.created) });
  }

  readView(event, zone, ctz) {
    const { kind: _k, etag: _e, availability: _a, visibility: _v, ...shown } = event;
    for (const key of ["start", "end", "originalStartTime"]) {
      const t = shown[key];
      if (t?.dateTime) shown[key] = { ...t, dateTime: formatInZone(parseInstant(t.dateTime), zone) };
    }
    if (ctz) shown.htmlLink += `&ctz=${ctz}`;
    return sorted(shown);
  }
  writeView(event) {
    const { kind: _k, etag: _e, useDefaultReminders: _u, overrideReminders: _o, ...shown } = event;
    for (const key of ["start", "end"]) if (shown[key]?.dateTime) shown[key] = { ...shown[key], dateTime: seconds(parseInstant(shown[key].dateTime)) };
    shown.htmlLink = shown.htmlLink.replace(READ_LINK, WRITE_LINK);
    return sorted({ availability: "AVAILABILITY_BUSY", visibility: "default", ...shown });
  }
  window(cal, args) {
    const zone = args.timeZone ?? this.zone(cal);
    const a = this.time(args.startTime, zone, "startTime"), b = this.time(args.endTime, zone, "endTime");
    if (!(b > a)) this.gap("the copy has not seen the hosted server answer an empty or reversed time range");
    if (!this.copy.covered(cal, a, b)) this.gap(`the copy has not seen all events of ${cal.id} between ${new Date(a).toISOString()} and ${new Date(b).toISOString()}`);
    return { a, b, zone };
  }
  between(cal, a, b) { return this.copy.expanded(cal, a, b).filter(e => e.status !== "cancelled"); }

  call(op, args) {
    if (!TOOLS.includes(op)) this.gap(`${op} is not a tool of Google's hosted Calendar MCP server`);
    return this[op](args);
  }

  list_calendars(args) {
    known(args, ["pageSize"]);
    if (!this.copy.listComplete || !this.order) this.gap("the copy has not seen the hosted server list every calendar");
    if (this.order.length > (args.pageSize ?? 100)) this.gap("the copy has not seen the hosted server page the calendar list");
    return sorted({ calendars: this.order });
  }

  list_events(args) {
    known(args, ["calendarId", "startTime", "endTime", "timeZone", "orderBy", "fullText", "pageSize"]);
    const cal = this.cal(args.calendarId);
    if (!cal.hosted?.updated) this.gap(`the copy has not seen the hosted server describe calendar ${cal.id}`);
    const { a, b, zone } = this.window(cal, args);
    let events = this.between(cal, a, b).filter(e => LISTED_TYPES.includes(e.eventType ?? "DEFAULT"));
    if (args.fullText !== undefined) events = events.filter(e => matches(e, args.fullText));
    const start = e => parseInstant(e.start?.dateTime);
    if (events.some(e => !Number.isFinite(start(e)))) this.gap("the copy has not seen the hosted server list all-day events");
    if (args.orderBy === "startTime") events.sort((x, y) => start(x) - start(y));
    else if (args.orderBy === "startTimeDesc") events.sort((x, y) => start(y) - start(x));
    else if (args.orderBy === "lastModified") events.sort((x, y) => Date.parse(x.updated) - Date.parse(y.updated));
    else if (events.length > 1) this.gap("the copy does not know the hosted server's default order");
    if (events.length > (args.pageSize ?? 100)) this.gap("the copy has not seen the hosted server page events");
    const { accessRole, defaultReminders, summary, timeZone, updated } = cal.hosted;
    return sorted({ accessRole, defaultReminders, ...(events.length ? { events: events.map(e => this.readView(e, zone, args.timeZone)) } : {}), summary, timeZone, updated });
  }

  get_event(args) {
    known(args, ["calendarId", "eventId"]);
    const cal = this.cal(args.calendarId);
    return this.readView(this.event(cal, args.eventId, false), this.zone(cal));
  }

  // The hosted server searches by meaning, so the copy answers only a query it saw answered live,
  // and only while nothing that query could newly match has changed since.
  search_events(args) {
    known(args, ["query", "pageSize"]);
    const seen = this.searches.findLast(s => s.query === args.query);
    if (!seen) this.gap(`the copy has not seen the hosted server answer the search ${JSON.stringify(args.query)}`);
    if (seen.ids.length >= seen.limit) this.gap(`the search ${JSON.stringify(args.query)} was seen with a full page, so the copy does not know the rest`);
    const cal = this.cal(undefined);
    const events = [];
    for (const event of cal.events.values()) {
      if (event.status === "cancelled") continue;
      if (Date.parse(event.updated) > seen.at) this.gap(`event ${event.id} changed after the search ${JSON.stringify(args.query)} was seen, and the copy cannot tell whether it matches now`);
      if (seen.ids.includes(event.id)) events.push(event);
    }
    for (const change of this.changes) if (change.at > seen.at && cal.events.get(change.id)?.status !== "cancelled") this.gap(`event ${change.id} changed after the search ${JSON.stringify(args.query)} was seen, and the copy cannot tell whether it matches now`);
    if (events.length !== seen.ids.filter(id => cal.events.get(id)?.status !== "cancelled").length) this.gap("the copy has lost an event of a search it saw");
    if (events.length > (args.pageSize ?? 100)) this.gap("the copy has not seen the hosted server page a search");
    const order = new Map(seen.ids.map((id, i) => [id, i]));
    events.sort((x, y) => order.get(x.id) - order.get(y.id));
    return sorted(events.length ? { events: events.map(e => this.readView(e, this.zone(cal))) } : {});
  }

  suggest_time(args) {
    known(args, ["attendeeEmails", "startTime", "endTime", "timeZone", "durationMinutes"]);
    if (!args.timeZone) this.gap("the copy has only seen suggest_time with a timeZone");
    const emails = args.attendeeEmails ?? [];
    if (!emails.length || emails.some(email => email !== this.me())) this.gap("the copy has only seen suggest_time for the user's own calendar");
    const cal = this.cal(undefined);
    const { a, b } = this.window(cal, { ...args, timeZone: args.timeZone });
    const events = this.between(cal, a, b);
    if (events.some(e => !e.start?.dateTime)) this.gap("the copy does not know whether an all-day event blocks time");
    const inferred = this.availability(cal);
    const busy = events.filter(e => {
      const blocks = e.availability ? e.availability !== "AVAILABILITY_FREE" : inferred.get(e.id);
      if (blocks === undefined) this.gap(`the hosted server's reads do not say whether event ${e.id} blocks time, and no suggest_time the copy saw tells`);
      return blocks;
    });
    const minutes = args.durationMinutes ?? 30;
    const slots = freeStretches(a, b, busy, minutes);
    const shown = ms => ({ dateTime: formatInZone(ms, args.timeZone), timeZone: args.timeZone });
    return sorted(slots.length ? { timeSlots: slots.map(([s, e]) => ({ durationMinutes: Math.round((e - s) / 60000), end: shown(e), endTime: formatInZone(e, args.timeZone), start: shown(s), startTime: formatInZone(s, args.timeZone) })) } : {});
  }

  // Which events block time, worked out from suggest_time answers the copy saw: an event whose availability no answer
  // showed is busy (or free) when only that choice gives back the free stretches the server answered.
  availability(cal) {
    const known = new Map();
    if (!this.suggested.length || !this.copy.primary) return known;
    const events = [...cal.events.values()];
    for (const seen of this.suggested) {
      if (seen.emails.length !== 1 || seen.emails[0] !== this.copy.primary || !this.copy.covered(cal, seen.a, seen.b)) continue;
      if (events.some(e => Date.parse(e.updated) > seen.at && !(Date.parse(e.created) > seen.at))) continue;
      if (this.changes.some(change => change.at > seen.at && !(change.created > seen.at))) continue;
      const present = events.filter(e => e.status !== "cancelled" && !(Date.parse(e.created) > seen.at) && parseInstant(e.end?.dateTime ?? "") > seen.a && parseInstant(e.start?.dateTime ?? "") < seen.b);
      if (this.copy.expanded(cal, seen.a, seen.b).some(e => !e.start?.dateTime)) continue;
      const fixed = present.filter(e => e.availability), open = present.filter(e => !e.availability);
      if (open.length > 8) continue;
      const fits = [];
      for (let mask = 0; mask < 1 << open.length; mask++) {
        const busy = [...fixed.filter(e => e.availability !== "AVAILABILITY_FREE"), ...open.filter((_, i) => mask >> i & 1)];
        if (JSON.stringify(freeStretches(seen.a, seen.b, busy, seen.minutes)) === JSON.stringify(seen.slots)) fits.push(mask);
      }
      if (!fits.length) continue;
      open.forEach((e, i) => { if (fits.every(mask => (mask >> i & 1) === (fits[0] >> i & 1))) known.set(e.id, !!(fits[0] >> i & 1)); });
    }
    return known;
  }

  own(list) {
    for (const person of list ?? []) if ((typeof person === "string" ? person : person?.email) !== this.me()) this.gap("the copy has not seen the hosted server invite guests");
  }

  create_event(args) {
    known(args, ["summary", "startTime", "endTime", "timeZone", "description", "location", "notificationLevel", "attendees", "attendeeEmails", "calendarId"]);
    if (args.calendarId !== undefined && args.calendarId !== "primary" && args.calendarId !== this.me()) this.gap("the copy has only seen the hosted server create events on the primary calendar");
    this.own(args.attendees); this.own(args.attendeeEmails);
    const cal = this.cal(undefined);
    const s = this.time(args.startTime, args.timeZone, "startTime"), e = this.time(args.endTime, args.timeZone, "endTime");
    if (!(e > s)) this.gap("the copy has not seen the hosted server create an event that ends before it starts");
    const now = this.copy.now(), me = { email: this.me(), self: true };
    const id = Array.from(randomBytes(26), byte => B32[byte % 32]).join("");
    const event = keep({
      availability: "AVAILABILITY_BUSY", conferenceData: {}, created: seconds(now), creator: me,
      ...(args.description !== undefined ? { description: args.description } : {}),
      end: { dateTime: formatInZone(e, args.timeZone), timeZone: args.timeZone }, eventType: "DEFAULT", htmlLink: this.copy.link(id, cal), id,
      ...(args.location !== undefined ? { location: args.location } : {}),
      organizer: me, start: { dateTime: formatInZone(s, args.timeZone), timeZone: args.timeZone }, status: "confirmed", summary: args.summary, updated: seconds(now), visibility: "default",
    });
    cal.events.set(id, event);
    this.wrote(cal, now, event);
    return this.writeView(event);
  }

  update_event(args) {
    known(args, ["eventId", "calendarId", "summary", "description", "location", "startTime", "endTime", "timeZone", "notificationLevel"]);
    const cal = this.cal(args.calendarId);
    const current = this.event(cal, args.eventId);
    const next = { ...current };
    for (const key of ["summary", "description", "location"]) if (args[key] !== undefined) next[key] = args[key];
    if (args.startTime !== undefined || args.endTime !== undefined) {
      const zone = args.timeZone;
      const was = [parseInstant(current.start?.dateTime), parseInstant(current.end?.dateTime)];
      if (!was.every(Number.isFinite)) this.gap("the copy has not seen the hosted server move an all-day event");
      const s = args.startTime !== undefined ? this.time(args.startTime, zone, "startTime") : was[0];
      const e = args.endTime !== undefined ? this.time(args.endTime, zone, "endTime") : s + was[1] - was[0];
      if (!(e > s)) this.gap("the copy has not seen the hosted server move an event to end before it starts");
      next.start = { dateTime: formatInZone(s, zone), timeZone: zone };
      next.end = { dateTime: formatInZone(e, zone), timeZone: zone };
    } else if (args.timeZone !== undefined) this.gap("the copy has not seen the hosted server change only an event's time zone");
    const now = this.copy.now();
    next.updated = seconds(now);
    cal.events.set(next.id, next);
    this.wrote(cal, now, next);
    return this.writeView(next);
  }

  delete_event(args) {
    known(args, ["eventId", "calendarId", "notificationLevel"]);
    const cal = this.cal(args.calendarId);
    const current = this.event(cal, args.eventId);
    const now = this.copy.now();
    cal.events.set(current.id, { ...current, status: "cancelled", updated: seconds(now) });
    this.wrote(cal, now, current);
    return { id: current.id, status: "cancelled" };
  }

  respond_to_event(args) {
    known(args, ["eventId", "calendarId", "responseStatus", "notificationLevel", "responseComment"]);
    const cal = this.cal(args.calendarId);
    const current = this.event(cal, args.eventId);
    if (current.attendees?.some(a => a.self || a.email === this.me())) this.gap("the copy has not seen the hosted server record a response");
    return { error: NOT_ATTENDEE };
  }

  // Learning from what the session saw the hosted server answer.
  learn(op, args, value, observedAt) {
    const copy = this.copy;
    if (op === "list_calendars") {
      for (const entry of value.calendars ?? []) copy.putEntry(entry);
      if (!args.pageToken && !value.nextPageToken) { copy.listComplete = true; this.order = value.calendars ?? []; }
      return;
    }
    if (op === "list_events") {
      if (args.calendarId === undefined && copy.calendars.get(value.summary)?.entry) copy.setPrimary(value.summary);
      copy.cal(args.calendarId ?? "primary").hosted = { accessRole: value.accessRole, defaultReminders: value.defaultReminders, summary: value.summary, timeZone: value.timeZone, updated: value.updated };
      const events = value.events ?? [];
      for (const event of events) this.put(copy.cal(args.calendarId ?? "primary"), event);
      const cal = copy.cal(args.calendarId ?? "primary");
      if (args.fullText !== undefined || args.eventType !== undefined || args.pageToken || value.nextPageToken) return;
      const zone = args.timeZone ?? value.timeZone;
      const a = typeof args.startTime === "string" && zone ? naiveToMs(args.startTime, zone) : NaN, b = typeof args.endTime === "string" && zone ? naiveToMs(args.endTime, zone) : NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a)) return;
      const at = Date.parse(observedAt ?? "") || 0, listed = new Set(events.map(e => e.id));
      for (const event of copy.expanded(cal, a, b, true)) if (!listed.has(event.id)) this.changes.push({ id: event.id, at, created: Date.parse(event.created) });
      copy.dropWindowEvents(cal, a, b, listed);
      copy.addWindow(cal, a, b);
      return;
    }
    if (op === "search_events") {
      const cal = copy.cal("primary");
      for (const event of value.events ?? []) this.put(cal, event);
      this.searches.push({ query: args.query, ids: (value.events ?? []).map(e => e.id), limit: args.pageSize ?? 100, at: Date.parse(observedAt ?? "") || 0 });
      return;
    }
    if (op === "suggest_time") {
      const a = typeof args.startTime === "string" && args.timeZone ? naiveToMs(args.startTime, args.timeZone) : NaN, b = typeof args.endTime === "string" && args.timeZone ? naiveToMs(args.endTime, args.timeZone) : NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a) || args.preferences !== undefined) return;
      this.suggested.push({ emails: args.attendeeEmails ?? [], a, b, minutes: args.durationMinutes ?? 30, slots: (value.timeSlots ?? []).map(s => [parseInstant(s.startTime), parseInstant(s.endTime)]), at: Date.parse(observedAt ?? "") || 0 });
      return;
    }
    if (op === "get_event" && value.id) return this.put(copy.cal(args.calendarId ?? "primary"), value);
    if (["create_event", "update_event"].includes(op) && value.id) this.put(copy.cal(args.calendarId ?? "primary"), value);
    else if (op === "delete_event" && value.status === "cancelled") {
      const cal = copy.cal(args.calendarId ?? "primary");
      const event = cal.events.get(args.eventId);
      if (event) cal.events.set(event.id, { ...event, status: "cancelled", updated: seconds(Date.parse(observedAt ?? "") || Date.parse(event.updated)) });
    } else return;
    const at = Date.parse(observedAt ?? "");
    const cal = copy.cal(args.calendarId ?? "primary");
    const event = cal.events.get(value.id ?? args.eventId);
    if (!Number.isFinite(at) || !event) return;
    this.changes.push({ id: event.id, at, created: Date.parse(event.created) });
    if (cal.hosted && !(Date.parse(cal.hosted.updated) > at)) cal.hosted.updated = upSeconds(at);
  }
  put(cal, event) {
    if (!event?.id) return;
    cal.events.set(event.id, keep(event, cal.events.get(event.id)));
    if (event.creator?.self && event.creator.email) this.copy.setPrimary(event.creator.email);
  }
}

function freeStretches(a, b, events, minutes) {
  const busy = events.map(e => [Math.max(a, parseInstant(e.start.dateTime)), Math.min(b, parseInstant(e.end.dateTime))]).sort((x, y) => x[0] - y[0]);
  const slots = [];
  let at = a;
  for (const [s, e] of [...busy, [b, b]]) {
    if (s - at >= minutes * 60000) slots.push([at, s]);
    at = Math.max(at, e);
  }
  return slots;
}

function matches(event, query) {
  const text = [event.summary, event.description, event.location, ...(event.attendees ?? []).flatMap(a => [a.email, a.displayName])].filter(Boolean).join(" ").toLowerCase();
  return String(query).toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}
