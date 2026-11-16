import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test, { after, before } from "node:test";
import pg from "pg";
import { createCopy } from "../src/api.mjs";
import { takeSnapshot } from "../src/dump.mjs";
import { seed } from "../src/seed.mjs";

let root, process;
let serial = 0;
async function client(database = "postgres") {
  const connection = new pg.Client({ host: root, user: "supabase_admin", database });
  await connection.connect();
  return connection;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "supabase-review-"));
  const data = join(root, "data");
  cpSync("/var/lib/phoenix/pgdata", data, { recursive: true });
  process = spawn(join(globalThis.process.env.PHOENIX_PG_BIN, "postgres"), ["-D", data,
    "-c", "listen_addresses=", "-c", "unix_socket_directories=" + root,
    "-c", "shared_buffers=32MB"], { stdio: "ignore" });
  for (let attempt = 0; ; attempt++) {
    try { const connection = await client(); await connection.end(); break; }
    catch (error) {
      if (attempt === 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const connection = await client();
  try { await connection.query("CREATE ROLE postgres LOGIN SUPERUSER; CREATE ROLE supabase_read_only_user LOGIN"); }
  finally { await connection.end(); }
});

after(async () => {
  if (process) { const stopped = once(process, "exit"); process.kill("SIGINT"); await stopped; }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture(setup, options) {
  const source = "source_" + ++serial, destination = "copy_" + serial;
  const admin = await client();
  try { await admin.query(`CREATE DATABASE ${source}`); await admin.query(`CREATE DATABASE ${destination}`); }
  finally { await admin.end(); }
  const real = await client(source);
  await real.query(setup);
  const snapshot = await takeSnapshot(async sql => (await real.query(sql)).rows, options);
  const target = await client(destination);
  try {
    const result = await seed(target, snapshot);
    assert.deepEqual(result, { errors: [], skipped: [] });
  } finally { await target.end(); }
  const copy = createCopy({ snapshot, replies: [], socket: root, database: destination });
  await copy.ready();
  return { real, copy, snapshot };
}

const sql = (copy, query) => copy.handle("POST", "/v1/projects/synthetic/database/query", "api.supabase.com", JSON.stringify({ query, read_only: false }));

test("S1: zero statistics do not prove an uncaptured table is empty", async () => {
  const { real, copy, snapshot } = await fixture(
    "SET track_counts = off; CREATE TABLE items (id int); INSERT INTO items VALUES (1)",
    { tables: [] });
  try {
    assert.equal(Number(snapshot.relations.find(rel => rel.name === "items").live_rows), 0);
    assert.equal(snapshot.rows["public.items"], undefined);
    assert.deepEqual((await real.query("SELECT * FROM items")).rows, [{ id: 1 }]);
    copy.begin();
    const answer = await sql(copy, "SELECT * FROM items");
    assert.equal(answer.status, 501, `Uncaptured real rows became a successful answer: ${answer.body}`);
  } finally { await real.end(); }
});

test("S2: a function cannot read a partially captured table as if it were complete", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2); " +
    "CREATE FUNCTION item_count() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT count(*) FROM items); END $$",
    { tables: ["items"], rowLimit: 1 });
  try {
    assert.equal((await real.query("SELECT item_count() AS n")).rows[0].n, "2");
    copy.begin();
    assert.equal((await sql(copy, "SELECT count(*) FROM items")).status, 501);
    copy.begin();
    const answer = await sql(copy, "SELECT item_count() AS n");
    assert.equal(answer.status, 501, `Hidden read returned a count from partial rows: ${answer.body}`);
  } finally { await real.end(); }
});

test("S3: migrations must not compute writes from partially captured rows", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2)",
    { tables: ["items"], rowLimit: 1 });
  try {
    const query = "CREATE TABLE totals AS SELECT count(*) AS n FROM items";
    await real.query(query);
    assert.equal((await real.query("SELECT n FROM totals")).rows[0].n, "2");
    copy.begin();
    const answer = await copy.handle("POST", "/v1/projects/synthetic/database/migrations", "api.supabase.com", JSON.stringify({ name: "totals", query }));
    const readback = await sql(copy, "SELECT n FROM totals");
    assert.equal(answer.status, 501, `Migration succeeded with the wrong later read: ${readback.body}`);
  } finally { await real.end(); }
});

test("S4: logs from an unrelated time window must miss", async () => {
  const url = (start, end) => "https://api.supabase.com/v1/projects/synthetic/analytics/endpoints/logs?" + new URLSearchParams({
    sql: "select timestamp, event_message from postgres_logs", iso_timestamp_start: start, iso_timestamp_end: end,
  });
  const old = url("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
  const requested = url("2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z");
  const copy = createCopy({ replies: [{ method: "GET", url: old, status: 200,
    body: JSON.stringify([{ timestamp: "2026-11-10T12:00:00Z", event_message: "synthetic old event" }]) }] });
  copy.begin();
  const answer = await copy.handle("GET", requested, "api.supabase.com");
  assert.equal(answer.status, 501, `An unseen window returned unrelated recorded logs: ${answer.body}`);
});
