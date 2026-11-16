// Builds a Postgres from a snapshot taken by dump.mjs: roles, schemas, extensions, types, functions, tables, rows,
// constraints, indexes, views, triggers, row level security, comments, owners and grants.
const id = name => '"' + String(name).replaceAll('"', '""') + '"';
const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
const qual = (schema, name) => id(schema) + "." + id(name);
const LIST_SETTINGS = new Set(["local_preload_libraries", "search_path", "session_preload_libraries", "shared_preload_libraries", "temp_tablespaces", "unix_socket_directories"]);
const PRIVILEGES = { r: "SELECT", w: "UPDATE", a: "INSERT", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER", X: "EXECUTE", U: "USAGE", C: "CREATE", c: "CONNECT", T: "TEMPORARY", m: "MAINTAIN" };

function parseAcl(item) {
  const match = /^(.*)=([a-zA-Z*]*)\/(.*)$/.exec(item);
  if (!match) return undefined;
  const unquote = name => name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
  const grants = [], options = [];
  for (let i = 0; i < match[2].length; i++) {
    const privilege = PRIVILEGES[match[2][i]];
    if (!privilege) continue;
    (match[2][i + 1] === "*" ? options : grants).push(privilege);
  }
  return { grantee: match[1] === "" ? "PUBLIC" : id(unquote(match[1])), grantor: unquote(match[3]), grants, options };
}

function grants(kind, object, owner, acl, columns = "") {
  if (!acl) return [];
  const out = columns ? [] : ["REVOKE ALL ON " + kind + " " + object + " FROM PUBLIC", "REVOKE ALL ON " + kind + " " + object + " FROM " + id(owner)];
  for (const item of acl) {
    const parsed = parseAcl(item);
    if (!parsed) continue;
    const by = parsed.grantor !== owner ? " GRANTED BY " + id(parsed.grantor) : "";
    const list = privileges => privileges.map(p => p + columns).join(", ");
    if (parsed.grants.length) out.push("GRANT " + list(parsed.grants) + " ON " + kind + " " + object + " TO " + parsed.grantee + by);
    if (parsed.options.length) out.push("GRANT " + list(parsed.options) + " ON " + kind + " " + object + " TO " + parsed.grantee + " WITH GRANT OPTION" + by);
  }
  return out;
}

export function statements(snapshot, available) {
  const phases = { roles: [], schemas: [], extensions: [], types: [], sequences: [], functions: [], tables: [], views: [], data: [], constraints: [], indexes: [], triggers: [], security: [], comments: [], owners: [], grants: [] };
  const skipped = [];
  for (const role of snapshot.roles) {
    const attributes = [role.super ? "SUPERUSER" : "NOSUPERUSER", role.inherit ? "INHERIT" : "NOINHERIT", role.createrole ? "CREATEROLE" : "NOCREATEROLE", role.createdb ? "CREATEDB" : "NOCREATEDB",
      role.login ? "LOGIN" : "NOLOGIN", role.replication ? "REPLICATION" : "NOREPLICATION", role.bypassrls ? "BYPASSRLS" : "NOBYPASSRLS", "CONNECTION LIMIT " + role.connlimit].join(" ");
    phases.roles.push({ sql: "DO $phoenix$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = " + lit(role.name) + ") THEN CREATE ROLE " + id(role.name) + "; END IF; END $phoenix$" });
    phases.roles.push({ sql: "ALTER ROLE " + id(role.name) + " " + attributes });
    for (const setting of role.config ?? []) {
      const at = setting.indexOf("=");
      const name = setting.slice(0, at);
      phases.roles.push({ sql: "ALTER ROLE " + id(role.name) + " SET " + id(name) + " = " + (LIST_SETTINGS.has(name) ? setting.slice(at + 1) : lit(setting.slice(at + 1))) });
    }
  }
  for (const role of snapshot.roles) for (const group of role.member_of ?? [])
    phases.roles.push({ sql: "GRANT " + id(group.role) + " TO " + id(role.name) + " WITH ADMIN " + (group.admin ? "TRUE" : "FALSE") + ", INHERIT " + (group.inherit ? "TRUE" : "FALSE") + ", SET " + (group.set ? "TRUE" : "FALSE") });
  for (const schema of snapshot.namespaces) {
    phases.schemas.push({ sql: "CREATE SCHEMA IF NOT EXISTS " + id(schema.name) });
    phases.owners.push({ sql: "ALTER SCHEMA " + id(schema.name) + " OWNER TO " + id(schema.owner) });
    if (schema.comment !== null) phases.comments.push({ sql: "COMMENT ON SCHEMA " + id(schema.name) + " IS " + lit(schema.comment) });
    phases.grants.push(...grants("SCHEMA", id(schema.name), schema.owner, schema.acl).map(sql => ({ sql })));
  }
  for (const extension of snapshot.extensions) {
    if (extension.name === "plpgsql") continue;
    if (!available.has(extension.name)) { skipped.push("extension " + extension.name + ": not available in this Postgres"); continue; }
    phases.extensions.push({ sql: "CREATE SCHEMA IF NOT EXISTS " + id(extension.schema) });
    phases.extensions.push({ oid: extension.oid, sql: "CREATE EXTENSION IF NOT EXISTS " + id(extension.name) + " WITH SCHEMA " + id(extension.schema) + " VERSION " + lit(extension.version), fallback: "CREATE EXTENSION IF NOT EXISTS " + id(extension.name) + " WITH SCHEMA " + id(extension.schema) });
  }
  for (const type of snapshot.types) {
    const name = qual(type.schema, type.name);
    if (type.kind === "e") phases.types.push({ oid: type.oid, sql: "CREATE TYPE " + name + " AS ENUM (" + (type.labels ?? []).map(lit).join(", ") + ")" });
    else if (type.kind === "d") phases.types.push({ oid: type.oid, sql: "CREATE DOMAIN " + name + " AS " + type.base + (type.default !== null ? " DEFAULT " + type.default : "") + (type.notnull ? " NOT NULL" : "") + (type.checks ?? []).map(c => " CONSTRAINT " + id(c.name) + " " + c.def).join("") });
    else if (type.kind === "c") phases.types.push({ oid: type.oid, sql: "CREATE TYPE " + name + " AS (" + (type.fields ?? []).map(f => id(f.name) + " " + f.type).join(", ") + ")" });
    else if (type.kind === "r") phases.types.push({ oid: type.oid, sql: "CREATE TYPE " + name + " AS RANGE (SUBTYPE = " + type.subtype + ")" });
    phases.owners.push({ sql: "ALTER TYPE " + name + " OWNER TO " + id(type.owner) });
    if (type.comment !== null) phases.comments.push({ sql: "COMMENT ON TYPE " + name + " IS " + lit(type.comment) });
    phases.grants.push(...grants("TYPE", name, type.owner, type.acl).map(sql => ({ sql })));
  }
  for (const fn of snapshot.functions) {
    if (!fn.def) { skipped.push("aggregate " + fn.schema + "." + fn.name + ": aggregates are not rebuilt"); continue; }
    const signature = qual(fn.schema, fn.name) + "(" + fn.args + ")";
    const kind = fn.kind === "p" ? "PROCEDURE" : "FUNCTION";
    phases.functions.push({ oid: fn.oid, sql: fn.def });
    phases.owners.push({ sql: "ALTER " + kind + " " + signature + " OWNER TO " + id(fn.owner) });
    if (fn.comment !== null) phases.comments.push({ sql: "COMMENT ON " + kind + " " + signature + " IS " + lit(fn.comment) });
    phases.grants.push(...grants(kind, signature, fn.owner, fn.acl).map(sql => ({ sql })));
  }
  const relations = snapshot.relations;
  for (const rel of relations.filter(r => r.kind === "S")) {
    const name = qual(rel.schema, rel.name), s = rel.sequence;
    if (!s) continue;
    if (!s.owned_by?.identity) phases.sequences.push({ oid: rel.oid, sql: "CREATE SEQUENCE " + name + " AS " + s.type + " INCREMENT " + s.increment + " MINVALUE " + s.min + " MAXVALUE " + s.max + " START " + s.start + " CACHE " + s.cache + (s.cycle ? " CYCLE" : " NO CYCLE") });
    else phases.constraints.push({ sql: "ALTER SEQUENCE " + name + " INCREMENT " + s.increment + " MINVALUE " + s.min + " MAXVALUE " + s.max + " START " + s.start + " CACHE " + s.cache + (s.cycle ? " CYCLE" : " NO CYCLE") });
    if (s.owned_by && !s.owned_by.identity) phases.constraints.push({ sql: "ALTER SEQUENCE " + name + " OWNED BY " + s.owned_by.table + "." + id(s.owned_by.column) });
    if (s.last_value !== null) phases.data.push({ sql: "SELECT setval(" + lit(name) + ", " + s.last_value + ", true)", after: true });
    if (!s.owned_by?.identity) phases.owners.push({ sql: "ALTER SEQUENCE " + name + " OWNER TO " + id(rel.owner) });
    phases.grants.push(...grants("SEQUENCE", name, rel.owner, rel.acl).map(sql => ({ sql })));
  }
  const sequences = new Map(relations.filter(r => r.kind === "S" && r.sequence?.owned_by?.identity).map(r => [r.sequence.owned_by.table + "." + r.sequence.owned_by.column, qual(r.schema, r.name)]));
  for (const rel of relations.filter(r => r.kind === "r" || r.kind === "p")) {
    const name = qual(rel.schema, rel.name);
    const columns = (rel.columns ?? []).filter(c => !rel.partition_of || c.local).map(c => {
      let text = id(c.name) + " " + c.type + (c.collation ? " COLLATE " + c.collation : "");
      if (c.generated === "s") text += " GENERATED ALWAYS AS (" + c.default + ") STORED";
      else if (c.identity) text += " GENERATED " + (c.identity === "a" ? "ALWAYS" : "BY DEFAULT") + " AS IDENTITY" + (sequences.has(name + "." + c.name) ? " (SEQUENCE NAME " + sequences.get(name + "." + c.name) + ")" : "");
      else if (c.default !== null) text += " DEFAULT " + c.default;
      if (c.notnull) text += " NOT NULL";
      return text;
    });
    const head = "CREATE " + (rel.persistence === "u" ? "UNLOGGED " : "") + "TABLE " + name;
    const body = rel.partition_of ? " PARTITION OF " + rel.partition_of.parent + " " + rel.partition_of.bound : " (" + columns.join(", ") + ")";
    phases.tables.push({ oid: rel.oid, sql: head + body + (rel.partkey ? " PARTITION BY " + rel.partkey : "") + (rel.options?.length ? " WITH (" + rel.options.join(", ") + ")" : ""), order: rel.partition_of ? 1 : 0 });
    if (rel.rls) phases.security.push({ sql: "ALTER TABLE " + name + " ENABLE ROW LEVEL SECURITY" });
    if (rel.rls_forced) phases.security.push({ sql: "ALTER TABLE " + name + " FORCE ROW LEVEL SECURITY" });
    if (rel.comment !== null) phases.comments.push({ sql: "COMMENT ON TABLE " + name + " IS " + lit(rel.comment) });
    for (const c of rel.columns ?? []) {
      if (c.comment !== null) phases.comments.push({ sql: "COMMENT ON COLUMN " + name + "." + id(c.name) + " IS " + lit(c.comment) });
      phases.grants.push(...grants("TABLE", name, rel.owner, c.acl, " (" + id(c.name) + ")").map(sql => ({ sql })));
    }
    phases.owners.push({ sql: "ALTER TABLE " + name + " OWNER TO " + id(rel.owner) });
    phases.grants.push(...grants("TABLE", name, rel.owner, rel.acl).map(sql => ({ sql })));
    const data = snapshot.rows?.[rel.schema + "." + rel.name];
    if (data?.length) {
      const insertable = (rel.columns ?? []).filter(c => c.generated !== "s").map(c => id(c.name));
      const always = (rel.columns ?? []).some(c => c.identity === "a");
      phases.data.push({ sql: "INSERT INTO " + name + " (" + insertable.join(", ") + ")" + (always ? " OVERRIDING SYSTEM VALUE" : "") + " SELECT " + insertable.join(", ") + " FROM json_populate_recordset(null::" + name + ", $1::json)", params: [JSON.stringify(data)] });
    }
  }
  for (const rel of relations.filter(r => r.kind === "v" || r.kind === "m")) {
    const name = qual(rel.schema, rel.name);
    const kind = rel.kind === "m" ? "MATERIALIZED VIEW" : "VIEW";
    phases.views.push({ oid: rel.oid, sql: "CREATE " + kind + " " + name + (rel.options?.length ? " WITH (" + rel.options.join(", ") + ")" : "") + " AS " + rel.viewdef.replace(/;\s*$/, "") + (rel.kind === "m" ? " WITH NO DATA" : "") });
    if (rel.kind === "m") phases.triggers.push({ sql: "REFRESH MATERIALIZED VIEW " + name });
    if (rel.comment !== null) phases.comments.push({ sql: "COMMENT ON " + kind + " " + name + " IS " + lit(rel.comment) });
    phases.owners.push({ sql: "ALTER " + kind + " " + name + " OWNER TO " + id(rel.owner) });
    phases.grants.push(...grants("TABLE", name, rel.owner, rel.acl).map(sql => ({ sql })));
  }
  for (const c of snapshot.constraints) {
    phases.constraints.push({ sql: "ALTER TABLE " + c.relation + " ADD CONSTRAINT " + id(c.name) + " " + c.def, ...(c.kind === "f" ? { fallback: "ALTER TABLE " + c.relation + " ADD CONSTRAINT " + id(c.name) + " " + c.def + " NOT VALID", order: 1 } : {}) });
    if (c.comment !== null) phases.comments.push({ sql: "COMMENT ON CONSTRAINT " + id(c.name) + " ON " + c.relation + " IS " + lit(c.comment) });
  }
  for (const index of snapshot.indexes) phases.indexes.push({ sql: index.def });
  for (const trigger of snapshot.triggers) {
    phases.triggers.push({ sql: trigger.def });
    if (trigger.enabled === "D") phases.triggers.push({ sql: "ALTER TABLE " + trigger.relation + " DISABLE TRIGGER " + id(trigger.name) });
    if (trigger.enabled === "R") phases.triggers.push({ sql: "ALTER TABLE " + trigger.relation + " ENABLE REPLICA TRIGGER " + id(trigger.name) });
    if (trigger.enabled === "A") phases.triggers.push({ sql: "ALTER TABLE " + trigger.relation + " ENABLE ALWAYS TRIGGER " + id(trigger.name) });
  }
  const COMMANDS = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };
  for (const p of snapshot.policies)
    phases.security.push({ sql: "CREATE POLICY " + id(p.name) + " ON " + p.relation + " AS " + (p.permissive ? "PERMISSIVE" : "RESTRICTIVE") + " FOR " + COMMANDS[p.command] + " TO " + p.roles.join(", ") + (p.using !== null ? " USING (" + p.using + ")" : "") + (p.check !== null ? " WITH CHECK (" + p.check + ")" : "") });
  const OBJECTS = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };
  for (const d of snapshot.defaults) for (const item of d.acl ?? []) {
    const parsed = parseAcl(item);
    if (!parsed || !OBJECTS[d.type]) continue;
    const where = "ALTER DEFAULT PRIVILEGES FOR ROLE " + id(d.role) + (d.schema ? " IN SCHEMA " + id(d.schema) : "");
    if (parsed.grants.length) phases.grants.push({ sql: where + " GRANT " + parsed.grants.join(", ") + " ON " + OBJECTS[d.type] + " TO " + parsed.grantee });
    if (parsed.options.length) phases.grants.push({ sql: where + " GRANT " + parsed.options.join(", ") + " ON " + OBJECTS[d.type] + " TO " + parsed.grantee + " WITH GRANT OPTION" });
  }
  return { phases, skipped };
}

export async function seed(client, snapshot) {
  const available = new Set((await client.query("select name from pg_available_extensions")).rows.map(r => r.name));
  const { phases, skipped } = statements(snapshot, available);
  const errors = [];
  await client.query("SET check_function_bodies = off");
  await client.query("SET search_path = " + snapshot.meta.search_path);
  const run = async step => {
    try { await client.query(step.sql, step.params); return true; }
    catch (error) {
      if (step.fallback) { try { await client.query(step.fallback); errors.push({ sql: step.sql.slice(0, 300), error: error.message, used: "fallback" }); return true; } catch {} }
      return error;
    }
  };
  const runAll = async steps => {
    let left = [];
    for (const step of [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      if (await run(step) !== true) { left.push(step); continue; }
      for (let at = 0; at < left.length;) {
        if (await run(left[at]) === true) { left.splice(at, 1); at = 0; } else at++;
      }
    }
    for (let round = 0; left.length && round < 6; round++) {
      const failed = [];
      for (const step of left) { const result = await run(step); if (result !== true) failed.push({ step, error: result }); }
      if (failed.length === left.length) { left = failed.map(f => f.step); for (const f of failed) errors.push({ sql: f.step.sql.slice(0, 300), error: f.error.message }); break; }
      left = failed.map(f => f.step);
      if (!left.length) break;
      if (round === 5) for (const f of failed) errors.push({ sql: f.step.sql.slice(0, 300), error: f.error.message });
    }
  };
  await runAll(phases.roles);
  if (snapshot.meta.database_owner) await runAll([{ sql: "ALTER DATABASE " + id(snapshot.meta.database) + " OWNER TO " + id(snapshot.meta.database_owner) }]);
  await runAll(phases.schemas);
  const objects = [...phases.types, ...phases.sequences, ...phases.functions, ...phases.tables, ...phases.views];
  const creates = phases.extensions.filter(step => step.oid !== undefined);
  if (creates.length && objects.every(step => step.oid !== undefined || !step.sql.startsWith("CREATE"))) {
    await runAll(phases.extensions.filter(step => step.oid === undefined));
    await runAll([...creates, ...objects].sort((a, b) => Number(a.oid ?? Infinity) - Number(b.oid ?? Infinity)));
  } else {
    await runAll(phases.extensions);
    await runAll(objects);
  }
  await client.query("SET session_replication_role = replica");
  await runAll(phases.data.filter(step => !step.after));
  await runAll(phases.data.filter(step => step.after));
  await runAll(phases.constraints);
  await client.query("SET session_replication_role = origin");
  for (const name of ["indexes", "triggers", "security", "comments", "owners", "grants"]) await runAll(phases[name]);
  await client.query("RESET ALL");
  return { errors, skipped };
}
