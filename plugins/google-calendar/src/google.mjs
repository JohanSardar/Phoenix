import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Unknown, basicDate, basicUtc, formatInZone, naiveToMs, occurrences, parseInstant, validZone, wallOf, wallToMs } from "./time.mjs";

// Google's public color palette (the same for every account).
const PALETTE = {"calendar":{"1":{"background":"#ac725e","foreground":"#1d1d1d"},"2":{"background":"#d06b64","foreground":"#1d1d1d"},"3":{"background":"#f83a22","foreground":"#1d1d1d"},"4":{"background":"#fa573c","foreground":"#1d1d1d"},"5":{"background":"#ff7537","foreground":"#1d1d1d"},"6":{"background":"#ffad46","foreground":"#1d1d1d"},"7":{"background":"#42d692","foreground":"#1d1d1d"},"8":{"background":"#16a765","foreground":"#1d1d1d"},"9":{"background":"#7bd148","foreground":"#1d1d1d"},"10":{"background":"#b3dc6c","foreground":"#1d1d1d"},"11":{"background":"#fbe983","foreground":"#1d1d1d"},"12":{"background":"#fad165","foreground":"#1d1d1d"},"13":{"background":"#92e1c0","foreground":"#1d1d1d"},"14":{"background":"#9fe1e7","foreground":"#1d1d1d"},"15":{"background":"#9fc6e7","foreground":"#1d1d1d"},"16":{"background":"#4986e7","foreground":"#1d1d1d"},"17":{"background":"#9a9cff","foreground":"#1d1d1d"},"18":{"background":"#b99aff","foreground":"#1d1d1d"},"19":{"background":"#c2c2c2","foreground":"#1d1d1d"},"20":{"background":"#cabdbf","foreground":"#1d1d1d"},"21":{"background":"#cca6ac","foreground":"#1d1d1d"},"22":{"background":"#f691b2","foreground":"#1d1d1d"},"23":{"background":"#cd74e6","foreground":"#1d1d1d"},"24":{"background":"#a47ae2","foreground":"#1d1d1d"}},"event":{"1":{"background":"#a4bdfc","foreground":"#1d1d1d"},"2":{"background":"#7ae7bf","foreground":"#1d1d1d"},"3":{"background":"#dbadff","foreground":"#1d1d1d"},"4":{"background":"#ff887c","foreground":"#1d1d1d"},"5":{"background":"#fbd75b","foreground":"#1d1d1d"},"6":{"background":"#ffb878","foreground":"#1d1d1d"},"7":{"background":"#46d6db","foreground":"#1d1d1d"},"8":{"background":"#e1e1e1","foreground":"#1d1d1d"},"9":{"background":"#5484ed","foreground":"#1d1d1d"},"10":{"background":"#51b749","foreground":"#1d1d1d"},"11":{"background":"#dc2127","foreground":"#1d1d1d"}}};

const ORDER = ["kind", "etag", "id", "status", "htmlLink", "created", "updated", "summary", "description", "location", "colorId", "creator", "organizer", "start", "end", "endTimeUnspecified", "recurrence", "recurringEventId", "originalStartTime", "transparency", "visibility", "iCalUID", "sequence", "attendees", "attendeesOmitted", "extendedProperties", "hangoutLink", "conferenceData", "gadget", "anyoneCanAddSelf", "guestsCanInviteOthers", "guestsCanModify", "guestsCanSeeOtherGuests", "privateCopy", "locked", "reminders", "source", "workingLocationProperties", "outOfOfficeProperties", "focusTimeProperties", "attachments", "birthdayProperties", "eventType"];
const TIME_FIELDS = ["start", "end"];
const B32 = "0123456789abcdefghijklmnopqrstuv";

export const ordered = event => {
  const out = {};
  for (const key of ORDER) if (event[key] !== undefined) out[key] = event[key];
  for (const [key, value] of Object.entries(event)) if (!(key in out) && value !== undefined) out[key] = value;
  return out;
};

// Google stores some IANA zone names under the zone they link to (seen live: Europe/Ljubljana is returned as Europe/Belgrade).
const LINKS = { "Europe/Ljubljana": "Europe/Belgrade", "Europe/Zagreb": "Europe/Belgrade", "Europe/Sarajevo": "Europe/Belgrade", "Europe/Skopje": "Europe/Belgrade", "Europe/Podgorica": "Europe/Belgrade" };
const canonicalZone = zone => LINKS[zone] ?? zone;
const VALID_ID = /^[a-v0-9]{5,1024}(_\d{8}(T\d{6}Z)?)?$/;
const GROUP_ID = /^(c_)?[a-z0-9]+@group\.calendar\.google\.com$/;
const pretty = value => JSON.stringify(value, null, 1);
const isoMs = ms => new Date(ms).toISOString();
const apiError = (code, reason, message) => ({ status: code, body: { error: { errors: [{ domain: "global", reason, message }], code, message } } });

export class Copy {
  constructor() {
    this.calendars = new Map();
    this.primary = undefined;
    this.listComplete = false;
    this.gaps = [];
    this.now = () => Date.now();
    this.counter = 0;
  }

  takeGaps() { const gaps = this.gaps; this.gaps = []; return gaps; }
  gap(why) { this.gaps.push(why); throw new Unknown(why); }

  calId(id) { return id === "primary" ? this.primary ?? "primary" : id; }
  cal(id) {
    const key = this.calId(decodeURIComponent(id));
    let cal = this.calendars.get(key);
    if (!cal) { cal = { id: key, entry: undefined, events: new Map(), overridden: new Map(), windows: [], busy: [] }; this.calendars.set(key, cal); }
    return cal;
  }
  zoneOf(cal) { return cal.entry?.timeZone ?? this.gap(`the copy does not know the time zone of calendar ${cal.id}`); }

  // ---- time helpers on stored events
  startMs(ev, cal) { return ev.start?.date ? this.dayMs(ev.start.date, cal) : parseInstant(ev.start?.dateTime); }
  endMs(ev, cal) { return ev.end?.date ? this.dayMs(ev.end.date, cal) : parseInstant(ev.end?.dateTime); }
  dayMs(date, cal) { const [y, m, d] = date.split("-").map(Number); return wallToMs(this.zoneOf(cal), y, m, d); }
  renderTime(t, zone) {
    if (!t || t.date || !t.dateTime) return t;
    const ms = parseInstant(t.dateTime);
    return Number.isFinite(ms) ? { ...t, dateTime: formatInZone(ms, zone) } : t;
  }
  render(ev, zone, ctz) {
    const out = { ...ev };
    if (ctz && out.htmlLink) out.htmlLink = `${out.htmlLink}&ctz=${ctz}`;
    for (const key of ["start", "end", "originalStartTime"]) if (out[key]) out[key] = this.renderTime(out[key], zone);
    return ordered(out);
  }
  link(id, cal) {
    const short = cal.id.replace(/@gmail\.com$/, "@m").replace(/@group\.calendar\.google\.com$/, "@g").replace(/@group\.v\.calendar\.google\.com$/, "@v");
    return "https://www.google.com/calendar/event?eid=" + Buffer.from(`${id} ${short}`).toString("base64").replace(/=+$/, "");
  }
  stamp() {
    const ms = Math.max(this.now(), (this.last ?? 0) + 1);
    this.last = ms;
    return { updated: isoMs(ms), etag: `"${ms * 2000}"` };
  }

  // ---- recurrence
  expand(master, cal, untilMs) {
    const zone = master.start.timeZone ?? this.zoneOf(cal);
    if (!validZone(zone)) this.gap(`unknown time zone ${zone}`);
    const allDay = !!master.start.date;
    let start;
    if (allDay) { const [y, m, d] = master.start.date.split("-").map(Number); start = { allDay, zone, y, m, d }; }
    else { const p = wallOf(zone, parseInstant(master.start.dateTime)); start = { allDay, zone, ...p }; }
    const duration = allDay ? Date.UTC(...master.end.date.split("-").map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(start.y, start.m - 1, start.d) : parseInstant(master.end.dateTime) - parseInstant(master.start.dateTime);
    try {
      return occurrences(master.recurrence, start, untilMs).map(o => {
        const id = allDay ? `${master.id}_${basicDate(o.date)}` : `${master.id}_${basicUtc(o.startMs)}`;
        const time = allDay ? { date: o.date } : { dateTime: formatInZone(o.startMs, zone), ...(master.start.timeZone ? { timeZone: master.start.timeZone } : {}) };
        const end = allDay ? { date: new Date(Date.UTC(...o.date.split("-").map((v, i) => i === 1 ? v - 1 : +v)) + duration).toISOString().slice(0, 10) } : { dateTime: formatInZone(o.startMs + duration, zone), ...(master.end.timeZone ? { timeZone: master.end.timeZone } : {}) };
        return { id, start: time, end, originalStartTime: time };
      });
    } catch (error) { if (error instanceof Unknown) this.gap(error.message); throw error; }
  }
  instanceOf(master, occ, cal) {
    const { recurrence: _r, ...rest } = master;
    return ordered({ ...rest, id: occ.id, htmlLink: this.link(occ.id, cal), start: occ.start, end: occ.end, recurringEventId: master.id, originalStartTime: occ.originalStartTime });
  }
  masterLink(master, cal) {
    if (!master.recurrence) return this.link(master.id, cal);
    try { const first = this.expand(master, cal, Infinity)[0]; return this.link(first ? first.id : master.id, cal); } catch { return this.link(master.id, cal); }
  }

  // Every event of a calendar (recurring series expanded) that overlaps [a, b).
  expanded(cal, a, b, showDeleted = false) {
    const out = new Map();
    for (const ev of cal.events.values()) {
      if (ev.recurrence) {
        if (ev.status === "cancelled") continue;
        for (const occ of this.expand(ev, cal, b)) {
          const stored = cal.events.get(occ.id);
          const instance = stored ?? this.instanceOf(ev, occ, cal);
          if (instance.status === "cancelled" && !showDeleted) continue;
          if (this.endMs(instance, cal) > a && this.startMs(instance, cal) < b) out.set(instance.id, instance);
        }
      }
    }
    for (const ev of cal.events.values()) {
      if (ev.recurrence || out.has(ev.id)) continue;
      if (ev.recurringEventId && cal.events.get(ev.recurringEventId)?.recurrence) continue;
      if (ev.status === "cancelled" && !showDeleted) continue;
      const s = this.startMs(ev, cal), e = this.endMs(ev, cal);
      if (e > a && s < b) out.set(ev.id, ev);
    }
    return [...out.values()];
  }

  covered(cal, a, b) {
    const ws = [...cal.windows].sort((x, y) => x[0] - y[0]);
    let at = a;
    for (const [s, e] of ws) { if (s > at) break; if (e > at) at = e; if (at >= b) return true; }
    return at >= b;
  }
  addWindow(cal, a, b) {
    if (!(b > a)) return;
    cal.windows.push([a, b]);
  }

  getEvent(cal, id) {
    const stored = cal.events.get(id);
    if (stored) return stored;
    const m = /^(.+)_(\d{8})(T\d{6}Z)?$/.exec(id);
    const master = m && cal.events.get(m[1]);
    if (master?.recurrence) {
      const occ = this.expand(master, cal, this.untilFor(id)).find(o => o.id === id);
      if (occ) return this.instanceOf(master, occ, cal);
    }
    return undefined;
  }
  untilFor(id) {
    const m = /_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(id);
    if (!m) return Infinity;
    return (m[4] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.UTC(+m[1], +m[2] - 1, +m[3])) + 2 * 86400000;
  }

  // ---- seeding
  putEvent(calId, ev) {
    const cal = this.cal(calId);
    const clean = { ...ev };
    for (const k of ["startDayOfWeek", "endDayOfWeek", "calendarId", "accountId"]) delete clean[k];
    if (!clean.kind) clean.kind = "calendar#event";
    if (!clean.etag && clean.updated) clean.etag = `"${Date.parse(clean.updated) * 2000}"`;
    cal.events.set(clean.id, ordered(clean));
    if (clean.creator?.self && clean.creator.email && !this.primary) this.setPrimary(clean.creator.email);
    return cal;
  }
  dropWindowEvents(cal, a, b, keep) {
    for (const [id, ev] of cal.events) {
      if (keep.has(id) || ev.recurrence) continue;
      try { if (this.endMs(ev, cal) > a && this.startMs(ev, cal) < b) cal.events.delete(id); } catch {}
    }
  }
  setPrimary(id) {
    if (this.primary === id) return;
    const old = this.calendars.get("primary");
    this.primary = id;
    if (old) {
      this.calendars.delete("primary");
      const cal = this.cal(id);
      for (const [k, v] of old.events) cal.events.set(k, v);
      cal.windows.push(...old.windows); cal.busy.push(...old.busy);
      cal.entry ??= old.entry;
    }
  }
  putEntry(entry) {
    if (entry.primary) this.setPrimary(entry.id);
    const cal = this.cal(entry.id);
    cal.entry = { kind: "calendar#calendarListEntry", etag: entry.etag ?? `"${createHash("sha1").update(entry.id).digest("hex").slice(0, 16)}"`, ...entry };
    return cal;
  }

  // ---- REST handlers
  async handle(method, url, body, headers = {}) {
    try {
      return this.route(method, url, body, headers);
    } catch (error) {
      if (error instanceof Unknown) return { status: 400, body: { error: { errors: [{ domain: "phoenix", reason: "notInCopy", message: error.message }], code: 400, message: error.message } }, gap: true };
      throw error;
    }
  }
  route(method, url, body, headers) {
    const u = new URL(url, "http://copy");
    const q = u.searchParams;
    const path = u.pathname.replace(/\/+$/, "");
    let m;
    if (method === "POST" && path === "/batch/calendar/v3") return this.batch(body, headers);
    if (method === "GET" && path === "/calendar/v3/colors") return { status: 200, body: { kind: "calendar#colors", updated: "2012-02-14T00:00:00.000Z", ...PALETTE } };
    if (method === "GET" && path === "/calendar/v3/users/me/calendarList") {
      if (!this.listComplete) this.gap("the copy has not seen the full calendar list");
      const items = [...this.calendars.values()].filter(c => c.entry).map(c => c.entry);
      return { status: 200, body: { kind: "calendar#calendarList", etag: `"p3${createHash("sha1").update(JSON.stringify(items.map(i => i.id))).digest("hex").slice(0, 14)}"`, nextSyncToken: "phoenix-copy", items } };
    }
    if (method === "GET" && (m = /^\/calendar\/v3\/users\/me\/calendarList\/([^/]+)$/.exec(path))) {
      const cal = this.cal(m[1]);
      if (cal.entry) return { status: 200, body: cal.entry };
      if (this.listComplete) return apiError(404, "notFound", "Not Found");
      this.gap(`the copy does not know calendar ${cal.id}`);
    }
    if (method === "GET" && (m = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(path))) {
      const cal = this.cal(m[1]);
      if (!cal.entry) this.gap(`the copy does not know calendar ${cal.id}`);
      const e = cal.entry;
      return { status: 200, body: { kind: "calendar#calendar", etag: e.etag, id: e.id, summary: e.summary, ...(e.description !== undefined ? { description: e.description } : {}), timeZone: e.timeZone, ...(e.conferenceProperties ? { conferenceProperties: e.conferenceProperties } : {}) } };
    }
    if (method === "POST" && path === "/calendar/v3/freeBusy") return this.freeBusy(JSON.parse(body || "{}"));
    if ((m = /^\/calendar\/v3\/calendars\/([^/]+)\//.exec(path)) && /@group\.calendar\.google\.com$/.test(decodeURIComponent(m[1])) && !GROUP_ID.test(decodeURIComponent(m[1]))) return apiError(404, "notFound", "Not Found");
    if ((m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path))) {
      if (method === "GET") return this.list(this.cal(m[1]), q);
      if (method === "POST") return this.insert(this.cal(m[1]), JSON.parse(body || "{}"), q);
    }
    if ((m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)\/instances$/.exec(path)) && method === "GET") return this.instances(this.cal(m[1]), decodeURIComponent(m[2]), q);
    if ((m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path))) {
      const cal = this.cal(m[1]), id = decodeURIComponent(m[2]);
      if (method === "GET") return this.get(cal, id, q);
      if (method === "PATCH" || method === "PUT") return this.patch(cal, id, JSON.parse(body || "{}"), method === "PUT");
      if (method === "DELETE") return this.remove(cal, id);
    }
    this.gap(`the copy does not implement ${method} ${path}`);
  }

  batch(body, headers) {
    const type = headers["content-type"] ?? "";
    const boundary = /boundary=("?)([^";]+)\1/.exec(type)?.[2];
    if (!boundary) return apiError(400, "badRequest", "Bad Request");
    const parts = body.split("--" + boundary).slice(1).filter(p => !p.startsWith("--"));
    const out = "batch_phoenixcopy" + (++this.counter);
    let text = "";
    let index = 0;
    for (const part of parts) {
      index++;
      const [head, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
      const id = /Content-ID:\s*<([^>]+)>/i.exec(head)?.[1] ?? `item${index}`;
      const request = rest.join("\r\n\r\n");
      const [line, ...more] = request.split("\r\n");
      const [method, target] = line.split(" ");
      const bodyAt = more.indexOf("");
      const subBody = bodyAt >= 0 ? more.slice(bodyAt + 1).join("\r\n").trim() : "";
      const reply = this.route(method, target, subBody, {});
      const status = reply.status;
      const reason = { 200: "OK", 204: "No Content", 400: "Bad Request", 404: "Not Found", 409: "Conflict", 410: "Gone" }[status] ?? "";
      text += `\r\n--${out}\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status} ${reason}\r\nVary: Origin\r\nContent-Type: application/json; charset=UTF-8\r\nVary: X-Origin\r\nVary: Referer\r\n\r\n${reply.body === undefined ? "" : pretty(reply.body)}\n`;
    }
    text += `\r\n--${out}--\r\n`;
    return { status: 200, raw: text, type: `multipart/mixed; boundary=${out}` };
  }

  list(cal, q) {
    const zone = q.get("timeZone") ?? this.zoneOf(cal);
    const a = q.has("timeMin") ? parseInstant(q.get("timeMin")) : NaN, b = q.has("timeMax") ? parseInstant(q.get("timeMax")) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) this.gap(`the copy only lists events of ${cal.id} inside a known time window`);
    if (q.get("singleEvents") !== "true") this.gap("the copy only answers lists with recurring events expanded");
    let items = [];
    if (a < b) {
      if (!this.covered(cal, a, b)) this.gap(`the copy has not seen the events of ${cal.id} between ${isoMs(a)} and ${isoMs(b)}`);
      items = this.expanded(cal, a, b, q.get("showDeleted") === "true");
    }
    for (const filter of q.getAll("privateExtendedProperty")) { const [k, v] = filter.split("="); items = items.filter(e => e.extendedProperties?.private?.[k] === v); }
    for (const filter of q.getAll("sharedExtendedProperty")) { const [k, v] = filter.split("="); items = items.filter(e => e.extendedProperties?.shared?.[k] === v); }
    if (q.get("q")) items = items.filter(e => matches(e, q.get("q")));
    if (q.has("eventTypes")) { const types = q.getAll("eventTypes"); items = items.filter(e => types.includes(e.eventType ?? "default")); }
    if (q.get("orderBy") === "startTime") items = [...items].sort((x, y) => this.startMs(x, cal) - this.startMs(y, cal) || this.endMs(y, cal) - this.endMs(x, cal) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    else if (q.get("orderBy") === "updated") items = [...items].sort((x, y) => Date.parse(x.updated) - Date.parse(y.updated));
    const max = Math.min(Number(q.get("maxResults") ?? 250) || 250, 2500);
    const offset = q.get("pageToken") ? Number(Buffer.from(q.get("pageToken"), "base64url").toString()) || 0 : 0;
    const page = items.slice(offset, offset + max).map(e => this.render(e, zone, q.get("timeZone")));
    const updated = [...cal.events.values()].map(e => Date.parse(e.updated)).filter(Number.isFinite);
    const e = cal.entry;
    const result = {
      kind: "calendar#events", etag: `"p3${createHash("sha1").update(JSON.stringify(page.map(i => i.etag))).digest("hex").slice(0, 14)}"`,
      summary: e.summaryOverride ?? e.summary, description: e.description ?? "", updated: isoMs(updated.length ? Math.max(...updated) : this.now()),
      timeZone: zone, accessRole: e.accessRole, defaultReminders: e.defaultReminders ?? [],
      ...(offset + max < items.length ? { nextPageToken: Buffer.from(String(offset + max)).toString("base64url") } : {}),
      items: page,
    };
    return { status: 200, body: q.get("fields") ? mask(result, q.get("fields")) : result };
  }

  instances(cal, id, q) {
    const master = cal.events.get(id);
    if (!master) this.gap(`the copy has not seen recurring event ${id}`);
    if (!master.recurrence) return apiError(400, "badRequest", "Bad Request");
    const a = q.has("timeMin") ? parseInstant(q.get("timeMin")) : -Infinity, b = q.has("timeMax") ? parseInstant(q.get("timeMax")) : Infinity;
    const zone = q.get("timeZone") ?? this.zoneOf(cal);
    const items = this.expand(master, cal, b).map(o => cal.events.get(o.id) ?? this.instanceOf(master, o, cal)).filter(i => (q.get("showDeleted") === "true" || i.status !== "cancelled") && this.endMs(i, cal) > a);
    const max = Math.min(Number(q.get("maxResults") ?? 250) || 250, 2500);
    const offset = q.get("pageToken") ? Number(Buffer.from(q.get("pageToken"), "base64url").toString()) || 0 : 0;
    const e = cal.entry ?? this.gap(`the copy does not know calendar ${cal.id}`);
    return { status: 200, body: { kind: "calendar#events", etag: `"p3${createHash("sha1").update(id).digest("hex").slice(0, 14)}"`, summary: e.summary, description: e.description ?? "", updated: master.updated, timeZone: zone, accessRole: e.accessRole, defaultReminders: e.defaultReminders ?? [], ...(offset + max < items.length ? { nextPageToken: Buffer.from(String(offset + max)).toString("base64url") } : {}), items: items.slice(offset, offset + max).map(i => this.render(i, zone)) } };
  }

  missing(cal, id) {
    if (!VALID_ID.test(id)) return true;
    const m = /^(.+)_(\d{8})(T\d{6}Z)?$/.exec(id);
    const master = m && cal.events.get(m[1]);
    return !!master?.recurrence && master.status !== "cancelled";
  }

  get(cal, id, q) {
    const ev = this.getEvent(cal, id);
    if (!ev && this.missing(cal, id)) return apiError(404, "notFound", "Not Found");
    if (!ev) this.gap(`the copy has not seen event ${id} in ${cal.id}`);
    return { status: 200, body: this.render(ev, q.get("timeZone") ?? this.zoneOf(cal), q.get("timeZone")), etag: ev.etag };
  }

  normalTime(value, zone, cal) {
    if (!value || typeof value !== "object") return value;
    const t = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
    if (t.date) return { date: t.date };
    if (!t.dateTime) return t;
    let ms = parseInstant(t.dateTime);
    if (!Number.isFinite(ms)) {
      const z = t.timeZone ?? this.zoneOf(cal);
      if (!validZone(z)) return { invalid: true };
      ms = naiveToMs(t.dateTime, z);
    }
    if (!Number.isFinite(ms)) return { invalid: true };
    return { dateTime: formatInZone(ms, zone), ...(t.timeZone ? { timeZone: canonicalZone(t.timeZone) } : {}) };
  }

  insert(cal, body, q) {
    const zone = this.zoneOf(cal);
    if (!cal.entry) this.gap(`the copy does not know calendar ${cal.id}`);
    if (body.conferenceData?.createRequest) this.gap("the copy cannot create Google Meet links");
    const id = body.id ?? Array.from(randomBytes(26), b => B32[b % 32]).join("");
    if (this.getEvent(cal, id)) return apiError(409, "duplicate", "The requested identifier already exists.");
    const start = this.normalTime(body.start, zone, cal), end = this.normalTime(body.end, zone, cal);
    if (!start || !end || start.invalid || end.invalid) return apiError(400, "required", "Missing end time.");
    const s = start.date ? this.dayMs(start.date, cal) : parseInstant(start.dateTime), e = end.date ? this.dayMs(end.date, cal) : parseInstant(end.dateTime);
    if (e < s) return apiError(400, "timeRangeEmpty", "The specified time range is empty.");
    const { updated, etag } = this.stamp();
    const owner = cal.id === this.primary ? this.primary : (cal.entry.accessRole === "owner" ? cal.id : this.primary);
    const self = { email: owner, self: true };
    const attendees = body.attendees?.map(a => ({ ...a, ...(a.email === owner ? { organizer: true, self: true } : {}), responseStatus: a.responseStatus ?? (a.email === owner ? "accepted" : "needsAction") }));
    const { kind: _k, etag: _e, created: _c, updated: _u, htmlLink: _h, iCalUID: _i, sequence: _s, creator: _cr, organizer: _o, status, ...fields } = body;
    const reminders = body.reminders ?? (start.date ? { useDefault: false, overrides: cal.entry.allDayReminders ?? cal.entry.defaultReminders ?? [] } : { useDefault: true });
    const ev = ordered({
      kind: "calendar#event", etag, id, status: status ?? "confirmed", htmlLink: "", created: new Date(Math.floor(Date.parse(updated) / 1000) * 1000).toISOString(), updated,
      ...fields, creator: self, organizer: self, start, end, ...(attendees ? { attendees } : {}),
      iCalUID: `${id}@google.com`, sequence: 0, reminders, eventType: body.eventType ?? "default",
    });
    ev.htmlLink = this.masterLink(ev, cal);
    cal.events.set(id, ordered(ev));
    return { status: 200, body: this.render(ev, zone), etag };
  }

  patch(cal, id, body, replace) {
    const zone = this.zoneOf(cal);
    const current = this.getEvent(cal, id);
    if (!current && this.missing(cal, id)) return apiError(404, "notFound", "Not Found");
    if (!current) this.gap(`the copy has not seen event ${id} in ${cal.id}`);
    if (current.status === "cancelled" && !body.status) return apiError(410, "deleted", "Resource has been deleted");
    if (body.conferenceData?.createRequest) this.gap("the copy cannot create Google Meet links");
    const next = replace ? { kind: current.kind, etag: current.etag, id, status: current.status, htmlLink: current.htmlLink, created: current.created, creator: current.creator, organizer: current.organizer, iCalUID: current.iCalUID, sequence: current.sequence, ...(current.recurringEventId ? { recurringEventId: current.recurringEventId, originalStartTime: current.originalStartTime } : {}), eventType: current.eventType } : { ...current };
    let timeChanged = false;
    const touched = cal.overridden.get(id) ?? new Set();
    for (const [key, value] of Object.entries(body)) {
      if (["kind", "etag", "id", "htmlLink", "created", "updated", "iCalUID", "creator", "organizer", "recurringEventId", "originalStartTime"].includes(key)) continue;
      touched.add(key);
      if (value === null) { delete next[key]; continue; }
      if (TIME_FIELDS.includes(key)) {
        const t = this.normalTime(value, zone, cal);
        if (t.invalid) return apiError(400, "invalid", "Invalid start time.");
        if (JSON.stringify(t) !== JSON.stringify(this.normalTime(current[key], zone, cal))) timeChanged = true;
        next[key] = t;
      } else next[key] = value;
    }
    if (next.start && next.end && this.endMs(next, cal) < this.startMs(next, cal)) return apiError(400, "timeRangeEmpty", "The specified time range is empty.");
    const { updated, etag } = this.stamp();
    next.updated = updated; next.etag = etag;
    if (timeChanged) next.sequence = (current.sequence ?? 0) + 1;
    if (next.recurrence || body.recurrence) next.htmlLink = this.masterLink(next, cal);
    cal.events.set(id, ordered(next));
    if (current.recurringEventId) cal.overridden.set(id, touched);
    if (next.recurrence) {
      for (const [otherId, other] of cal.events) {
        if (other.recurringEventId !== id) continue;
        const own = cal.overridden.get(otherId) ?? new Set();
        const copy = { ...other };
        for (const [key, value] of Object.entries(body)) if (!own.has(key) && !TIME_FIELDS.includes(key) && key !== "recurrence") { if (value === null) delete copy[key]; else copy[key] = value; }
        copy.etag = etag; copy.updated = updated;
        cal.events.set(otherId, ordered(copy));
      }
    }
    return { status: 200, body: this.render(next, zone), etag };
  }

  remove(cal, id) {
    const current = this.getEvent(cal, id);
    if (!current && this.missing(cal, id)) return apiError(404, "notFound", "Not Found");
    if (!current) this.gap(`the copy has not seen event ${id} in ${cal.id}`);
    if (current.status === "cancelled") return apiError(410, "deleted", "Resource has been deleted");
    const { updated, etag } = this.stamp();
    const { extendedProperties: _x, ...kept } = current;
    cal.events.set(id, ordered({ ...kept, status: "cancelled", updated, etag, sequence: (current.sequence ?? 0) + 1 }));
    return { status: 204, raw: "", type: "text/html" };
  }

  freeBusy(body) {
    const a = parseInstant(body.timeMin), b = parseInstant(body.timeMax);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return apiError(400, "badRequest", "Bad Request");
    const zone = body.timeZone ?? "UTC";
    const calendars = {};
    for (const { id } of body.items ?? []) {
      const cal = this.cal(id);
      let blocks;
      if (a >= b) blocks = [];
      else if (cal.entry && this.covered(cal, a, b)) {
        blocks = this.expanded(cal, a, b).filter(e => e.status !== "cancelled" && e.transparency !== "transparent" && e.eventType !== "workingLocation" && !e.attendees?.some(x => x.self && x.responseStatus === "declined")).map(e => [Math.max(a, this.startMs(e, cal)), Math.min(b, this.endMs(e, cal))]);
      } else {
        const seen = cal.busy.find(w => w.a <= a && w.b >= b);
        if (!seen) this.gap(`the copy has not seen ${id}'s free/busy between ${isoMs(a)} and ${isoMs(b)}`);
        blocks = seen.blocks.map(([s, e]) => [Math.max(a, s), Math.min(b, e)]).filter(([s, e]) => e > s);
      }
      blocks.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const block of blocks) { const last = merged.at(-1); if (last && block[0] <= last[1]) last[1] = Math.max(last[1], block[1]); else merged.push([...block]); }
      calendars[id] = { busy: merged.map(([s, e]) => ({ start: formatInZone(s, zone), end: formatInZone(e, zone) })) };
    }
    return { status: 200, body: { kind: "calendar#freeBusy", timeMin: isoMs(a), timeMax: isoMs(b), calendars } };
  }

  state() {
    return { primary: this.primary ?? null, calendars: [...this.calendars.values()].map(c => ({ id: c.id, known: !!c.entry, windows: c.windows.map(([a, b]) => [isoMs(a), isoMs(b)]), events: [...c.events.values()].sort((x, y) => x.id.localeCompare(y.id)) })) };
  }

  serve() {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const reply = await this.handle(req.method, req.url, Buffer.concat(chunks).toString("utf8"), req.headers);
      const headers = { "content-type": reply.type ?? "application/json; charset=UTF-8", ...(reply.etag ? { etag: reply.etag } : {}) };
      res.writeHead(reply.status, headers);
      res.end(reply.raw ?? (reply.body === undefined ? "" : pretty(reply.body)));
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
  }
}

export function matches(ev, query) {
  const text = [ev.summary, ev.description, ev.location, ev.organizer?.email, ev.organizer?.displayName, ...(ev.attendees ?? []).flatMap(a => [a.email, a.displayName])].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

function parseFields(spec) {
  const out = {};
  let i = 0;
  const read = () => {
    const node = {};
    while (i < spec.length) {
      let name = "";
      while (i < spec.length && !",()/".includes(spec[i])) name += spec[i++];
      name = name.trim();
      let child = true;
      if (spec[i] === "(") { i++; child = read(); i++; }
      else if (spec[i] === "/") { i++; const rest = read(); child = rest; }
      if (name) node[name] = child;
      if (spec[i] === ",") { i++; continue; }
      if (spec[i] === ")" || i >= spec.length) break;
    }
    return node;
  };
  Object.assign(out, read());
  return out;
}

export function mask(value, spec) {
  const apply = (v, tree) => {
    if (tree === true || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(x => apply(x, tree));
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k in tree) out[k] = apply(x, tree[k]);
    return out;
  };
  return apply(value, parseFields(spec));
}
