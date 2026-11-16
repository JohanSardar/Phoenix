// The read-only snapshot of a Supabase database: its structure and the rows of the tables a session read.
// Every statement here is a SELECT. takeSnapshot gets a function that runs one SELECT and returns its rows.
const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
const SYSTEM = "('pg_catalog', 'information_schema', 'pg_toast')";
const member = (catalog, column) => "not exists (select 1 from pg_depend d where d.classid = '" + catalog + "'::regclass and d.objid = " + column + " and d.deptype = 'e')";
const qualified = (schema, name) => "quote_ident(" + schema + ") || '.' || quote_ident(" + name + ")";

export function scopeFilter(schemas) {
  return schemas.length ? "in (" + schemas.map(lit).join(", ") + ")" : "not in " + SYSTEM + " and n.nspname !~ '^pg_(toast_)?temp_'";
}

export async function takeSnapshot(run, { schemas = [], tables = [], rowLimit = 1000 }) {
  const scope = "n.nspname " + scopeFilter(schemas);
  const [meta] = await run(
    "select current_setting('server_version_num')::int as version_num, current_setting('server_version') as version, current_setting('TimeZone') as timezone, " +
    "current_setting('DateStyle') as datestyle, current_setting('IntervalStyle') as intervalstyle, current_setting('search_path') as search_path, current_database() as database, version() as version_text, " +
    "(select pg_get_userbyid(d.datdba) from pg_database d where d.datname = current_database()) as database_owner, " +
    "current_setting('statement_timeout') as statement_timeout, current_setting('lc_messages') as lc_messages, current_setting('lc_monetary') as lc_monetary, current_setting('lc_numeric') as lc_numeric, " +
    "current_setting('lc_time') as lc_time, current_setting('default_text_search_config') as text_search, current_setting('shared_preload_libraries') as preload");
  const roles = await run(
    "select r.rolname as name, r.rolsuper as super, r.rolinherit as inherit, r.rolcreaterole as createrole, r.rolcreatedb as createdb, r.rolcanlogin as login, " +
    "r.rolreplication as replication, r.rolbypassrls as bypassrls, r.rolconnlimit as connlimit, r.rolconfig as config, " +
    "coalesce((select json_agg(json_build_object('role', g.rolname, 'admin', m.admin_option, 'inherit', m.inherit_option, 'set', m.set_option) order by g.rolname) " +
    "from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '[]') as member_of from pg_roles r where r.rolname !~ '^pg_' order by r.oid");
  const namespaces = await run(
    "select n.nspname as name, pg_get_userbyid(n.nspowner) as owner, n.nspacl::text[] as acl, obj_description(n.oid, 'pg_namespace') as comment " +
    "from pg_namespace n where " + scope + " and " + member("pg_namespace", "n.oid") + " order by n.oid");
  const extensions = await run(
    "select e.oid::int8 as oid, e.extname as name, e.extversion as version, n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by e.oid");
  const types = await run(
    "select t.oid::int8 as oid, n.nspname as schema, t.typname as name, t.typtype as kind, pg_get_userbyid(t.typowner) as owner, t.typacl::text[] as acl, obj_description(t.oid, 'pg_type') as comment, " +
    "(select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as labels, " +
    "case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end as base, t.typnotnull as notnull, pg_get_expr(t.typdefaultbin, 0) as default, " +
    "(select json_agg(json_build_object('name', c.conname, 'def', pg_get_constraintdef(c.oid)) order by c.oid) from pg_constraint c where c.contypid = t.oid) as checks, " +
    "(select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum) from pg_attribute a where t.typtype = 'c' and a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) as fields, " +
    "(select format_type(r.rngsubtype, null) from pg_range r where r.rngtypid = t.oid) as subtype " +
    "from pg_type t join pg_namespace n on n.oid = t.typnamespace where " + scope + " and " + member("pg_type", "t.oid") +
    " and (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')) order by t.oid");
  const functions = await run(
    "select p.oid::int8 as oid, n.nspname as schema, p.proname as name, p.prokind as kind, pg_get_function_identity_arguments(p.oid) as args, pg_get_userbyid(p.proowner) as owner, " +
    "p.proacl::text[] as acl, obj_description(p.oid, 'pg_proc') as comment, case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) end as def " +
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where " + scope + " and " + member("pg_proc", "p.oid") + " order by p.oid");
  const relations = await run(
    "select c.oid::int8 as oid, n.nspname as schema, c.relname as name, c.relkind as kind, c.relpersistence as persistence, pg_get_userbyid(c.relowner) as owner, c.relacl::text[] as acl, " +
    "obj_description(c.oid, 'pg_class') as comment, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forced, c.reloptions as options, " +
    "case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partkey, " +
    "(select json_build_object('parent', " + qualified("pn.nspname", "pc.relname") + ", 'bound', pg_get_expr(c.relpartbound, c.oid)) from pg_inherits i join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace where c.relispartition and i.inhrelid = c.oid) as partition_of, " +
    "case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end as viewdef, " +
    "(select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), " +
    "'generated', nullif(a.attgenerated::text, ''), 'identity', nullif(a.attidentity::text, ''), 'local', a.attislocal, 'comment', col_description(c.oid, a.attnum), 'acl', a.attacl::text[], " +
    "'collation', (select " + qualified("cn.nspname", "co.collname") + " from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation and a.attcollation <> t.typcollation)) order by a.attnum) " +
    "from pg_attribute a join pg_type t on t.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns, " +
    "(select json_build_object('type', format_type(s.seqtypid, null), 'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle, " +
    "'last_value', ps.last_value::text, 'owned_by', (select json_build_object('table', " + qualified("dn.nspname", "dc.relname") + ", 'column', da.attname, 'identity', dep.deptype = 'i') from pg_depend dep join pg_class dc on dc.oid = dep.refobjid join pg_namespace dn on dn.oid = dc.relnamespace join pg_attribute da on da.attrelid = dep.refobjid and da.attnum = dep.refobjsubid where dep.classid = 'pg_class'::regclass and dep.objid = c.oid and dep.refclassid = 'pg_class'::regclass and dep.deptype in ('a', 'i') limit 1)) " +
    "from pg_sequence s left join pg_sequences ps on ps.schemaname = n.nspname and ps.sequencename = c.relname where s.seqrelid = c.oid) as sequence, " +
    "(select st.n_live_tup from pg_stat_all_tables st where st.relid = c.oid) as live_rows " +
    "from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm', 'S') and " + scope + " and " + member("pg_class", "c.oid") + " order by c.oid");
  const constraints = await run(
    "select " + qualified("n.nspname", "r.relname") + " as relation, c.conname as name, c.contype as kind, pg_get_constraintdef(c.oid) as def, obj_description(c.oid, 'pg_constraint') as comment " +
    "from pg_constraint c join pg_class r on r.oid = c.conrelid join pg_namespace n on n.oid = r.relnamespace where c.contype in ('p', 'u', 'c', 'f', 'x') and c.conislocal and " + scope +
    " and " + member("pg_class", "r.oid") + " order by c.contype = 'f', case when c.contype = 'f' then c.ctid end, c.oid");
  const indexes = await run(
    "select " + qualified("n.nspname", "r.relname") + " as relation, ic.relname as name, pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class r on r.oid = i.indrelid " +
    "join pg_namespace n on n.oid = r.relnamespace where " + scope + " and " + member("pg_class", "r.oid") + " and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p', 'u', 'x')) " +
    "and not exists (select 1 from pg_inherits h where h.inhrelid = i.indexrelid) order by i.indexrelid");
  const triggers = await run(
    "select " + qualified("n.nspname", "r.relname") + " as relation, t.tgname as name, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as enabled from pg_trigger t join pg_class r on r.oid = t.tgrelid " +
    "join pg_namespace n on n.oid = r.relnamespace where not t.tgisinternal and t.tgparentid = 0 and " + scope + " and " + member("pg_class", "r.oid") + " order by t.oid");
  const policies = await run(
    "select " + qualified("n.nspname", "r.relname") + " as relation, p.polname as name, p.polpermissive as permissive, p.polcmd::text as command, " +
    "array(select case when x = 0 then 'public' else quote_ident(pg_get_userbyid(x)) end from unnest(p.polroles) x) as roles, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check " +
    "from pg_policy p join pg_class r on r.oid = p.polrelid join pg_namespace n on n.oid = r.relnamespace where " + scope + " order by p.oid");
  const defaults = await run(
    "select pg_get_userbyid(d.defaclrole) as role, n.nspname as schema, d.defaclobjtype::text as type, d.defaclacl::text[] as acl from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by d.oid");
  const rows = {};
  const wanted = tables.filter(name => typeof name === "string" && name).slice(0, 200);
  if (wanted.length && rowLimit > 0) {
    const names = "array[" + wanted.map(lit).join(", ") + "]::text[]";
    const picked = await run(
      "with recursive asked as (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm') and " + scope +
      " and (n.nspname || '.' || c.relname = any(" + names + ") or (c.relname = any(" + names + ") and n.nspname = any(current_schemas(false))))), " +
      "reach(oid, depth) as (select oid, 0 from asked union select x.oid, reach.depth + 1 from reach cross join lateral (" +
      "select distinct d.refobjid as oid from pg_rewrite w join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid and d.refclassid = 'pg_class'::regclass where w.ev_class = reach.oid and d.refobjid <> reach.oid " +
      "union select f.confrelid from pg_constraint f where f.contype = 'f' and f.conrelid = reach.oid " +
      "union select h.inhrelid from pg_inherits h where h.inhparent = reach.oid) x where reach.depth < 8) " +
      "select distinct n.nspname as schema, c.relname as name, " + qualified("n.nspname", "c.relname") + " as relation from reach join pg_class c on c.oid = reach.oid join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and " + scope + " limit 50");
    for (const { schema, name, relation } of picked) {
      const [result] = await run("select coalesce(json_agg(t), '[]'::json) as rows from (select * from " + relation + " limit " + Math.floor(rowLimit) + ") t");
      rows[schema + "." + name] = result.rows;
    }
  }
  return { phoenix_supabase_snapshot: 1, meta, roles, namespaces, extensions, types, functions, relations, constraints, indexes, triggers, policies, defaults, rows, row_limit: rowLimit };
}

const IDENTIFIER = '(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)';
const RELATION = new RegExp("\\b(?:from|join|update|into|table)\\s+(?:only\\s+)?(" + IDENTIFIER + "(?:\\s*\\.\\s*" + IDENTIFIER + ")?)", "gi");

export function tablesIn(sql) {
  const bare = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''").replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''");
  const names = new Set();
  for (const [, name] of bare.matchAll(RELATION)) {
    const parts = name.split(/\s*\.\s*/).map(part => part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase());
    names.add(parts.join("."));
  }
  return [...names];
}
