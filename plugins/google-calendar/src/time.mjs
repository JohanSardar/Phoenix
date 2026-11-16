export class Unknown extends Error {}

const formatters = new Map();
// Zones the copy worked out from offsets, by the name it hands out: each maps to every IANA zone that fits.
const fitted = new Map();

// Registers the zones that fit what Google showed and returns the name used for them.
export function fitZone(zones) {
  fitted.set(zones[0], zones);
  return zones[0];
}

function parts(zone, ms) {
  const zones = fitted.get(zone);
  if (!zones) return zoneParts(zone, ms);
  const p = zoneParts(zones[0], ms);
  if (zones.some(z => JSON.stringify(zoneParts(z, ms)) !== JSON.stringify(p))) throw new Unknown(`the copy cannot tell the calendar's local time at ${new Date(ms).toISOString()}, because it does not know the calendar's time zone`);
  return p;
}

function zoneParts(zone, ms) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

export function validZone(zone) {
  try { parts(zone, 0); return true; } catch { return false; }
}

export function offsetMinutes(zone, ms) {
  const p = parts(zone, ms);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}

export function wallToMs(zone, y, m, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, m - 1, d, h, mi, s);
  let ms = wall - offsetMinutes(zone, wall) * 60000;
  ms = wall - offsetMinutes(zone, ms) * 60000;
  return ms;
}

export function wallOf(zone, ms) { return parts(zone, ms); }

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function formatInZone(ms, zone) {
  const p = parts(zone, ms);
  const off = offsetMinutes(zone, ms);
  const sign = off < 0 ? "-" : "+";
  const tail = off === 0 ? "Z" : `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${tail}`;
}

export function dateOnly(ms, zone) {
  const p = parts(zone, ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function parseInstant(value) {
  if (typeof value !== "string") return NaN;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
}

export function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : undefined;
}

export function naiveToMs(value, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value ?? "");
  if (!m) return NaN;
  return wallToMs(zone, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

export function basicUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function basicDate(date) { return date.replaceAll("-", ""); }

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseRule(line) {
  const rule = {};
  for (const part of line.slice(6).split(";")) {
    const [k, v] = part.split("=");
    rule[k] = v;
  }
  const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);
  for (const k of Object.keys(rule)) if (!known.has(k)) throw new Unknown(`recurrence rule part ${k} is not supported by the copy`);
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.FREQ)) throw new Unknown(`recurrence frequency ${rule.FREQ} is not supported by the copy`);
  return {
    freq: rule.FREQ,
    interval: rule.INTERVAL ? +rule.INTERVAL : 1,
    count: rule.COUNT ? +rule.COUNT : undefined,
    until: rule.UNTIL,
    byday: rule.BYDAY ? rule.BYDAY.split(",").map(v => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(v); if (!m) throw new Unknown("bad BYDAY"); return { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) }; }) : undefined,
    bymonthday: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : undefined,
    bymonth: rule.BYMONTH ? rule.BYMONTH.split(",").map(Number) : undefined,
  };
}

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const addDays = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };

function monthDays(y, m, rule, dtstart) {
  const n = daysIn(y, m);
  let days = [];
  if (rule.bymonthday) days = rule.bymonthday.map(v => v < 0 ? n + 1 + v : v).filter(v => v >= 1 && v <= n);
  else if (rule.byday) {
    for (const { n: ord, wd } of rule.byday) {
      const all = [];
      for (let d = 1; d <= n; d++) if (weekday(y, m, d) === wd) all.push(d);
      if (!ord) days.push(...all);
      else { const pick = ord > 0 ? all[ord - 1] : all[all.length + ord]; if (pick) days.push(pick); }
    }
  } else if (dtstart.d <= n) days = [dtstart.d];
  return [...new Set(days)].sort((a, b) => a - b);
}

// Yields original starts (wall date parts) of every occurrence, in order, as {y,m,d}. Time of day comes from DTSTART.
function* dates(rule, dtstart) {
  let { y, m, d } = dtstart;
  const max = 100000;
  for (let step = 0; step < max; step++) {
    if (rule.freq === "DAILY") {
      if ((!rule.bymonth || rule.bymonth.includes(m)) && (!rule.byday || rule.byday.some(b => b.wd === weekday(y, m, d))) && (!rule.bymonthday || rule.bymonthday.includes(d))) yield { y, m, d };
      [y, m, d] = addDays(y, m, d, rule.interval);
    } else if (rule.freq === "WEEKLY") {
      const wds = rule.byday ? rule.byday.map(b => b.wd) : [weekday(dtstart.y, dtstart.m, dtstart.d)];
      const monday = addDays(y, m, d, -((weekday(y, m, d) + 6) % 7));
      for (let i = 0; i < 7; i++) {
        const [yy, mm, dd] = addDays(monday[0], monday[1], monday[2], i);
        if (wds.includes(weekday(yy, mm, dd)) && (!rule.bymonth || rule.bymonth.includes(mm))) yield { y: yy, m: mm, d: dd };
      }
      [y, m, d] = addDays(monday[0], monday[1], monday[2], 7 * rule.interval);
    } else if (rule.freq === "MONTHLY") {
      if (!rule.bymonth || rule.bymonth.includes(m)) for (const dd of monthDays(y, m, rule, dtstart)) yield { y, m, d: dd };
      m += rule.interval;
      while (m > 12) { m -= 12; y++; }
    } else {
      for (const mm of rule.bymonth ?? [dtstart.m]) for (const dd of monthDays(y, mm, rule, dtstart)) yield { y, m: mm, d: dd };
      y += rule.interval;
    }
  }
}

// Every occurrence of a recurring event as {startMs, date?} sorted by start, limited to starts before `untilMs`.
// start: {zone, y,m,d,h,mi,s, allDay}. Throws Unknown for anything the copy cannot expand faithfully.
export function occurrences(recurrence, start, untilMs) {
  const rules = recurrence.filter(l => l.startsWith("RRULE:")).map(parseRule);
  if (rules.length !== 1) throw new Unknown("only one RRULE per recurring event is supported by the copy");
  if (recurrence.some(l => !/^(RRULE|EXDATE)[:;]/.test(l))) throw new Unknown("RDATE and EXRULE are not supported by the copy");
  const exdates = new Set();
  for (const line of recurrence.filter(l => l.startsWith("EXDATE"))) {
    const [head, values] = line.split(":");
    const tzid = /TZID=([^;:]+)/.exec(head)?.[1];
    for (const v of values.split(",")) {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
      if (!m) throw new Unknown("bad EXDATE");
      if (!m[4]) exdates.add(`${m[1]}-${m[2]}-${m[3]}`);
      else exdates.add(m[7] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : wallToMs(tzid ?? start.zone, +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]));
    }
  }
  const rule = rules[0];
  let untilRule = Infinity;
  if (rule.until) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(rule.until);
    if (!m) throw new Unknown("bad UNTIL");
    untilRule = m[4] ? (m[7] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : wallToMs(start.zone, +m[1], +m[2], +m[3], +m[4], +m[5], +m[6])) : (start.allDay ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : wallToMs(start.zone, +m[1], +m[2], +m[3], 23, 59, 59));
  }
  if (rule.count === undefined && untilRule === Infinity && untilMs === Infinity) throw new Unknown("an endless recurrence needs a time window");
  const out = [];
  let counted = 0;
  const first = start.allDay ? Date.UTC(start.y, start.m - 1, start.d) : wallToMs(start.zone, start.y, start.m, start.d, start.h, start.mi, start.s);
  for (const { y, m, d } of dates(rule, start)) {
    const ms = start.allDay ? Date.UTC(y, m - 1, d) : wallToMs(start.zone, y, m, d, start.h, start.mi, start.s);
    if (ms < first) continue;
    if (ms > untilRule) break;
    if (rule.count !== undefined && counted >= rule.count) break;
    counted++;
    if (ms >= untilMs) break;
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if (start.allDay ? exdates.has(date) : exdates.has(ms)) continue;
    out.push(start.allDay ? { startMs: ms, date } : { startMs: ms });
  }
  return out;
}
