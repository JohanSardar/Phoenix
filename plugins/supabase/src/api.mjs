// The stand-in for Supabase's management API inside the box. SQL runs in the copy's own Postgres, the way the
// real /database/query endpoint runs it. Other requests are answered from the API replies in the snapshot.
// A request the copy cannot answer the way Supabase would is a miss, never a guess.
import pg from "pg";

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
  for (const reply of replies) {
    if (!reply.method || !reply.url) continue;
    const url = new URL(reply.url);
    const answer = { status: reply.status, headers: reply.headers ?? [], body: reply.body_base64 !== undefined ? Buffer.from(reply.body_base64, "base64") : Buffer.from(reply.body ?? "") };
    recorded.set(replyKey(reply.method, url, reply.request), answer);
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
  let watched = new Map();
  async function run(c, text, parameters) {
    if (!watched.size) {
      try { return { result: await c.query(parameters?.length ? { text, values: parameters } : text), partial: [] }; }
      catch (error) { if (!error.code) throw error; return { error, partial: [] }; }
    }
    if (/(^|;)\s*(begin|commit|rollback|end|abort|start|savepoint|release|prepare)\b/i.test(text)) return { partial: ["any table"] };
    let result, error;
    await c.query("BEGIN");
    await c.query("SAVEPOINT phoenix_statement");
    const names = (await admin("select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S'")).map(row => row.name);
    const sequences = names.length ? await admin(names.map(name => "select " + pg.Client.prototype.escapeLiteral(name) + " as name, last_value as value, is_called as called from " + name).join(" union all ")) : [];
    try { result = await c.query(parameters?.length ? { text, values: parameters } : text); await c.query("SET CONSTRAINTS ALL IMMEDIATE"); await c.query("RELEASE SAVEPOINT phoenix_statement"); }
    catch (thrown) { if (!thrown.code) throw thrown; error = thrown; await c.query("ROLLBACK TO SAVEPOINT phoenix_statement"); }
    const partial = (await c.query({ text: "select relid::int as oid from pg_stat_xact_all_tables where relid = any($1::oid[]) and seq_scan + coalesce(idx_scan, 0) + n_tup_ins + n_tup_upd + n_tup_del > 0", values: [[...watched.keys()]] })).rows.map(row => watched.get(row.oid));
    await c.query(partial.length || error ? "ROLLBACK" : "COMMIT");
    if (partial.length) for (const { name, value, called } of sequences) await admin({ text: "select setval($1::regclass, $2, $3)", values: [name, value, called] });
    return { result, error, partial };
  }
  const partialMiss = (partial, what) => missed("the snapshot " + partial.map(rel => unknown.get(rel) ?? "cannot tell which tables a statement with its own transaction control reads").join(" and ") + ", so " + what + " could differ from Supabase's");
  const recordedRows = new Map((snapshot?.relations ?? []).filter(r => r.live_rows !== null && r.live_rows !== undefined).map(r => [r.schema + "." + r.name, Number(r.live_rows)]));

  async function query(body) {
    if (!snapshot) return missed("the snapshot holds no database");
    const { query: text, parameters, read_only } = JSON.parse(body);
    const c = await client(read_only ? "supabase_read_only_user" : "postgres");
    let ran;
    try { ran = await run(c, text, parameters); } finally { await c.end(); }
    const { result, error, partial } = ran;
    if (partial.length) return partialMiss(partial, "the answer");
    if (error) {
      if (!read_only) wrote = true;
      return json(400, { message: "Failed to run sql query: " + formatError(error, text) });
    }
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
    const c = await client("postgres");
    let ran;
    try {
      if (watched.size) ran = await run(c, text);
      else {
        await c.query("BEGIN");
        try { await c.query(text); await c.query("COMMIT"); ran = { partial: [] }; }
        catch (error) { await c.query("ROLLBACK").catch(() => {}); if (!error.code) throw error; ran = { error, partial: [] }; }
      }
    } finally { await c.end(); }
    if (ran.partial.length) return partialMiss(ran.partial, "the migration");
    if (ran.error) return json(400, { message: "Failed to run sql query: " + formatError(ran.error, text) });
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
      if (unknown.size) watched = new Map((await admin("select c.oid::int as oid, n.nspname || '.' || c.relname as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p')")).filter(row => unknown.has(row.rel)).map(row => [row.oid, row.rel]));
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
      if (wrote && /\/analytics\/endpoints\/logs$/.test(url.pathname)) return missed("the replay wrote to the database, so the recorded logs may no longer be complete");
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
