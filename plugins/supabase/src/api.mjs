// The stand-in for Supabase's management API inside the box. SQL runs in the copy's own Postgres, the way the
// real /database/query endpoint runs it. Other requests are answered from the API replies in the snapshot.
// A request the copy cannot answer the way Supabase would is a miss, never a guess.
import pg from "pg";
import { tablesIn } from "./dump.mjs";

const RAW = value => value;
const TEXT_ARRAY = pg.types.getTypeParser(1009);
const PARSERS = { 20: value => (Number.isSafeInteger(Number(value)) ? Number(value) : value), 600: RAW, 718: RAW, 1082: RAW, 1114: RAW, 1184: RAW, 1186: RAW, 1115: TEXT_ARRAY, 1182: TEXT_ARRAY, 1185: TEXT_ARRAY };
const types = { getTypeParser: (oid, format) => PARSERS[oid] ?? pg.types.getTypeParser(oid, format) };
const SCHEMA_DEPENDENT = [/\/types\/typescript$/, /\/advisors\/(security|performance)$/, /^\/v2\/projects\/[^/]+\/advisors\/run$/];
const FINGERPRINT = "select md5(coalesce(string_agg(x, ',' order by x), '')) as fingerprint from (" +
  "select 'c' || c.oid || ':' || c.relname || ':' || c.relkind::text || ':' || c.relnamespace || ':' || c.relrowsecurity::text || ':' || coalesce(c.relacl::text, '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_(toast_)?temp_' " +
  "union all select 'a' || a.attrelid || ':' || a.attnum || ':' || a.attname || ':' || a.atttypid || ':' || a.attnotnull::text || ':' || a.attisdropped::text || ':' || coalesce(a.attacl::text, '') from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_(toast_)?temp_' " +
  "union all select 'p' || oid || ':' || md5(prosrc) || ':' || coalesce(proacl::text, '') from pg_proc where oid >= 16384 " +
  "union all select 'k' || oid || ':' || conname from pg_constraint where oid >= 16384 " +
  "union all select 'y' || oid || ':' || polname || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), '') from pg_policy " +
  "union all select 't' || oid || ':' || typname from pg_type where oid >= 16384 and typnamespace not in (select oid from pg_namespace where nspname ~ '^pg_(toast_)?temp_') " +
  "union all select 'e' || extname || ':' || extversion || ':' || extnamespace from pg_extension " +
  "union all select 'n' || oid || ':' || nspname || ':' || coalesce(nspacl::text, '') from pg_namespace where nspname !~ '^pg_(toast_)?temp_' " +
  "union all select 'g' || oid || ':' || tgname || ':' || tgenabled::text from pg_trigger where oid >= 16384) s(x)";

export function formatError(error, query) {
  let text = (error.severity ?? "ERROR") + ":  " + (error.code ? error.code + ": " : "") + error.message + "\n";
  const position = Number(error.position);
  if (position > 0) {
    const chars = Array.from(query);
    const before = chars.slice(0, position - 1).join("");
    const lines = before.split("\n");
    const number = lines.length;
    const column = Array.from(lines.at(-1)).length;
    const line = query.split("\n")[number - 1];
    const prefix = "LINE " + number + ": ";
    text += prefix + line + "\n" + " ".repeat(prefix.length + column) + "^\n";
  }
  if (error.detail) text += "DETAIL:  " + error.detail + "\n";
  if (error.hint) text += "HINT:  " + error.hint + "\n";
  if (error.where) text += "CONTEXT:  " + error.where + "\n";
  return text;
}

const json = (status, value) => ({ status, headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify(value)) });
const canonical = value => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

function replyKey(method, url, body) {
  const params = [...url.searchParams].sort(([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d));
  let request = "";
  if (body !== undefined && body !== "") { try { request = canonical(JSON.parse(body)); } catch { request = body; } }
  return [method, url.host, url.pathname, new URLSearchParams(params).toString(), request].join(" ");
}

export function createCopy({ snapshot, replies, socket, database }) {
  const recorded = new Map();
  const logs = [];
  for (const reply of replies) {
    if (!reply.method || !reply.url) continue;
    const url = new URL(reply.url);
    const answer = { status: reply.status, headers: reply.headers ?? [], body: reply.body_base64 !== undefined ? Buffer.from(reply.body_base64, "base64") : Buffer.from(reply.body ?? "") };
    recorded.set(replyKey(reply.method, url, reply.request), answer);
    if (/\/analytics\/endpoints\/logs$/.test(url.pathname)) logs.push({ url, answer });
  }
  const migrations = [];
  const statements = [];
  let misses = [];
  let wrote = false;
  let baseline;
  let liveBaseline = new Map();
  let extensionsBaseline = new Map();
  const missed = reason => { misses.push(reason); return json(501, { message: "The Phoenix working copy cannot answer this: " + reason }); };

  async function client(user) {
    const c = new pg.Client({ host: socket, user, database, application_name: "mgmt-api", options: "-c extra_float_digits=0", types });
    await c.connect();
    return c;
  }
  async function admin(sql) {
    const c = await client("supabase_admin");
    try { return (await c.query(sql)).rows; } finally { await c.end(); }
  }
  const liveRows = async () => new Map((await admin("select n.nspname || '.' || c.relname as rel, pg_stat_get_live_tuples(c.oid)::int as live from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p')")).map(r => [r.rel, r.live]));
  const installed = async () => new Map((await admin("select e.extname, e.extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace")).map(r => [r.extname, { version: r.extversion, schema: r.nspname }]));
  const unknown = new Map();
  for (const rel of snapshot?.relations ?? []) {
    if (rel.kind !== "r" && rel.kind !== "p") continue;
    const name = rel.schema + "." + rel.name, rows = snapshot.rows?.[name];
    if (rows && rows.length < (snapshot.row_limits?.[name] ?? 0)) continue;
    unknown.set(name, rows ? "holds only the first " + rows.length + " rows of " + name : "holds none of the rows of " + name);
  }
  const named = text => tablesIn(text.replace(/\$(\w*)\$/g, " ")).map(name => (name.includes(".") ? name : "public." + name));
  const calls = (text, fn) => new RegExp("(^|[^\\w$])" + fn.split(".")[1].replace(/[$]/g, "\\$&") + "\"?\\s*\\(", "i").test(text);
  const tainted = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of snapshot?.functions ?? []) {
      const name = fn.schema + "." + fn.name;
      if (tainted.has(name) || !fn.def) continue;
      if (named(fn.def).some(rel => unknown.has(rel)) || [...tainted].some(other => calls(fn.def, other))) { tainted.add(name); changed = true; }
    }
  }
  const triggers = new Map();
  for (const t of snapshot?.triggers ?? []) for (const fn of tainted) if (calls(t.def, fn)) triggers.set(t.relation.replaceAll('"', ""), fn);
  async function unanswerable(c, text, parameters) {
    if (!unknown.size) return [];
    const found = new Set(named(text));
    let plan = "";
    if (c) try {
      const [row] = (await c.query({ text: "EXPLAIN (VERBOSE, FORMAT JSON) " + text, values: parameters ?? [] })).rows;
      plan = JSON.stringify(row["QUERY PLAN"]);
      const walk = node => { if (!node || typeof node !== "object") return; if (node["Relation Name"]) found.add(node.Schema + "." + node["Relation Name"]); for (const value of Object.values(node)) walk(value); };
      walk(row["QUERY PLAN"]);
    } catch {}
    const reasons = [...found].filter(rel => unknown.has(rel)).map(rel => unknown.get(rel));
    for (const fn of tainted) if (calls(text, fn) || calls(plan, fn)) reasons.push("cannot run " + fn + " fully, because it reads a table the snapshot does not fully hold");
    for (const rel of found) if (triggers.has(rel)) reasons.push("cannot run the trigger function " + triggers.get(rel) + " on " + rel + " fully");
    return reasons;
  }
  const recordedRows = new Map((snapshot?.relations ?? []).filter(r => r.live_rows !== null && r.live_rows !== undefined).map(r => [r.schema + "." + r.name, Number(r.live_rows)]));

  async function query(body) {
    if (!snapshot) return missed("the snapshot holds no database");
    const { query: text, parameters, read_only } = JSON.parse(body);
    const c = await client(read_only ? "supabase_read_only_user" : "postgres");
    const reasons = await unanswerable(c, text, parameters);
    if (reasons.length) { await c.end(); return missed("the snapshot " + reasons.join(" and ") + ", so the answer could differ from Supabase's"); }
    let result;
    try { result = await c.query(parameters?.length ? { text, values: parameters } : text); }
    catch (error) {
      if (!error.code) throw error;
      if (!read_only) wrote = true;
      return json(400, { message: "Failed to run sql query: " + formatError(error, text) });
    }
    finally { await c.end(); }
    if (!read_only) { wrote = true; statements.push(text); }
    let rows = (Array.isArray(result) ? result.at(-1) : result).rows;
    if (text.includes("pg_stat_get_live_tuples(c.oid) AS live_rows_estimate")) {
      const now = await liveRows();
      rows = rows.map(row => {
        const rel = row.schema + "." + row.name;
        return recordedRows.has(rel) ? { ...row, live_rows_estimate: recordedRows.get(rel) + (now.get(rel) ?? 0) - (liveBaseline.get(rel) ?? 0) } : row;
      });
    }
    if (text.includes("pg_available_extensions() e(name, default_version, comment)")) {
      const reply = [...recorded.entries()].find(([key]) => key.includes("pg_available_extensions() e(name, default_version, comment)"))?.[1];
      if (!reply || reply.status >= 300) return missed("the snapshot holds no list of available extensions");
      const now = await installed();
      rows = JSON.parse(reply.body.toString("utf8")).map(row => {
        const before = extensionsBaseline.get(row.name), after = now.get(row.name);
        if (JSON.stringify(before) === JSON.stringify(after)) return row;
        return { ...row, schema: after?.schema ?? null, installed_version: after?.version ?? null };
      });
    }
    return json(201, rows);
  }

  async function applyMigration(body) {
    if (!snapshot) return missed("the snapshot holds no database");
    const { name, query: text } = JSON.parse(body);
    const reasons = await unanswerable(undefined, text);
    if (reasons.length) return missed("the snapshot " + reasons.join(" and ") + ", so the migration could end differently than on Supabase");
    const c = await client("postgres");
    try {
      await c.query("BEGIN");
      await c.query(text);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      if (!error.code) throw error;
      return json(400, { message: "Failed to run sql query: " + formatError(error, text) });
    } finally { await c.end(); }
    wrote = true;
    statements.push(text);
    const at = new Date();
    const pad = n => String(n).padStart(2, "0");
    migrations.push({ version: "" + at.getUTCFullYear() + pad(at.getUTCMonth() + 1) + pad(at.getUTCDate()) + pad(at.getUTCHours()) + pad(at.getUTCMinutes()) + pad(at.getUTCSeconds()), name });
    return json(200, {});
  }

  async function schemaChanged() {
    if (!wrote) return false;
    const [{ fingerprint }] = await admin(FINGERPRINT);
    return fingerprint !== baseline;
  }

  return {
    async ready() {
      if (!snapshot) return;
      const [{ fingerprint }] = await admin(FINGERPRINT);
      baseline = fingerprint;
      await admin("select pg_stat_force_next_flush()");
      liveBaseline = await liveRows();
      extensionsBaseline = await installed();
    },
    begin() { misses = []; },
    end() { const out = misses; misses = []; return out; },
    async handle(method, path, host, body) {
      const url = new URL(path, "https://" + host);
      if (method === "POST" && /^\/v1\/projects\/[^/]+\/database\/query$/.test(url.pathname)) return query(body);
      if (method === "POST" && /^\/v1\/projects\/[^/]+\/database\/migrations$/.test(url.pathname)) return applyMigration(body);
      if (SCHEMA_DEPENDENT.some(pattern => pattern.test(url.pathname)) && await schemaChanged()) return missed("the database changed in this replay, so the recorded " + url.pathname + " answer may no longer be true");
      const reply = recorded.get(replyKey(method, url, body));
      if (method === "GET" && /\/database\/migrations$/.test(url.pathname)) {
        if (!reply) return missed("the snapshot holds no migration list");
        return { ...reply, body: Buffer.from(JSON.stringify([...JSON.parse(reply.body.toString("utf8")), ...migrations])) };
      }
      if (reply) return reply;
      const one = method === "GET" && (/^(\/v1\/projects\/[^/]+\/functions)\/([^/]+)$/.exec(url.pathname) ?? /^(\/v2\/projects\/[^/]+\/notebooks)\/([^/]+)$/.exec(url.pathname));
      if (one) {
        const list = recorded.get(replyKey("GET", new URL(one[1], url.origin), undefined));
        const name = decodeURIComponent(one[2]);
        if (list?.status === 200 && !list.body.toString("utf8").includes(JSON.stringify(name))) {
          const value = one[1].endsWith("/functions") ? { message: "Function not found" } : { error: { code: "notebook_not_found", description: "Notebook " + name + " not found", message: "Notebook not found" } };
          return { status: 404, headers: [["content-type", "application/json; charset=utf-8"]], body: Buffer.from(JSON.stringify(value)) };
        }
      }
      if (method === "GET" && /\/analytics\/endpoints\/logs$/.test(url.pathname)) {
        const near = (a, b, key) => Math.abs(Date.parse(a.searchParams.get(key)) - Date.parse(b.searchParams.get(key))) < 120000;
        const rest = u => { const p = new URLSearchParams(u.searchParams); p.delete("iso_timestamp_start"); p.delete("iso_timestamp_end"); p.sort(); return p.toString(); };
        const match = logs.find(log => rest(log.url) === rest(url) && near(log.url, url, "iso_timestamp_start") && near(log.url, url, "iso_timestamp_end"));
        if (match && !wrote) return match.answer;
      }
      return missed("the snapshot holds no answer for " + method + " " + url.pathname);
    },
    state: async () => ({
      statements, migrations,
      rows: snapshot ? Object.fromEntries(await Promise.all(Object.keys(snapshot.rows ?? {}).map(async rel => {
        const [schema, ...name] = rel.split(".");
        const quoted = '"' + schema.replaceAll('"', '""') + '"."' + name.join(".").replaceAll('"', '""') + '"';
        try { return [rel, (await admin("select count(*)::int as n from " + quoted))[0].n]; } catch { return [rel, null]; }
      }))) : {},
    }),
  };
}
