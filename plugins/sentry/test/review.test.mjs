import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const now = "2026-11-16T12:00:00.000Z";
const issue = {
  id: "101", shortId: "WEB-1", title: "Synthetic error", status: "unresolved",
  substatus: "ongoing", statusDetails: {}, firstSeen: now, lastSeen: now,
  count: "1", userCount: 1, permalink: "https://demo.sentry.io/issues/101/",
  project: { id: "7", slug: "web", name: "Web" }, culprit: null,
  activity: [], participants: [], numComments: 0, isSubscribed: false,
};
const api = (path, value) => ({ method: "GET", url: `https://sentry.io/api/0${path}`,
  status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify(value) });
const listPath = (query, period = "30d") => `/organizations/demo/issues/?${new URLSearchParams({
  limit: "10", sort: "date", statsPeriod: period, query, collapse: "unhandled",
})}`;

async function processClient(t, script) {
  const child = spawn(process.execPath, [new URL(`../src/${script}.mjs`, import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH },
  });
  let next = 0;
  const pending = new Map();
  child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", resolve));
  createInterface({ input: child.stdout }).on("line", line => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  t.after(async () => { child.stdin.end(); await closed; });
  const request = (method, params) => new Promise(resolve => {
    const id = ++next;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id, method, params }) + "\n");
  });
  return { request };
}

async function serve(t, records) {
  const root = await mkdtemp(join(tmpdir(), "phoenix-sentry-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify([{ result: { _meta: { "phoenix/sentry-api": [
    api("/auth/", { id: "1", name: "Reviewer" }),
    api("/organizations/demo/issues/WEB-1/", issue), ...records,
  ] } } }]));
  const client = await processClient(t, "serve");
  const initialized = await client.request("initialize", { snapshot, now });
  assert.equal(initialized.status, "answer", JSON.stringify(initialized));
  return async (name, args) => {
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    const reply = await client.request("call", { surface: "mcp", layer: "agent",
      op: `tools/call:${name}`, args, now,
      raw: { body: Buffer.from(JSON.stringify(message)).toString("base64") },
    });
    if (reply.status === "answer") {
      reply.rpc = JSON.parse(Buffer.from(reply.value.body, "base64").toString());
      assert.equal(reply.rpc.error, undefined, JSON.stringify(reply.rpc));
      assert.notEqual(reply.rpc.result?.isError, true, JSON.stringify(reply.rpc));
    }
    return reply;
  };
}

test("S1: multi-status searches miss instead of answering stale data after resolve", { timeout: 15000 }, async t => {
  const query = "status:[resolved,ignored]";
  const call = await serve(t, [api(listPath("is:unresolved"), [issue]), api(listPath(query), [])]);
  const before = await call("search_issues", { organizationSlug: "demo", query });
  assert.equal(before.status, "answer", JSON.stringify(before));
  assert.deepEqual(before.rpc.result.structuredContent.issues, []);
  const resolved = await call("update_issue", { organizationSlug: "demo", issueId: "WEB-1", status: "resolved" });
  assert.equal(resolved.status, "answer", JSON.stringify(resolved));
  assert.equal(resolved.rpc.result.structuredContent.current.status, "resolved");
  const after = await call("search_issues", { organizationSlug: "demo", query });
  assert.equal(after.status, "unsupported", `A resolved issue now matches this query; the stale answer was ${JSON.stringify(after.rpc?.result.structuredContent)}`);
});

test("S2: resolving an old issue does not add it to a shorter-period search", { timeout: 15000 }, async t => {
  const oldIssue = { ...issue, firstSeen: "2026-09-17T12:00:00.000Z", lastSeen: "2026-09-17T12:00:00.000Z" };
  const call = await serve(t, [
    api("/organizations/demo/issues/WEB-1/", oldIssue),
    api(listPath("is:unresolved", "90d"), [oldIssue]),
    api(listPath("is:resolved", "30d"), []),
  ]);
  const args = { organizationSlug: "demo", query: "is:resolved", period: "30d" };
  const before = await call("search_issues", args);
  assert.equal(before.status, "answer", JSON.stringify(before));
  assert.deepEqual(before.rpc.result.structuredContent.issues, []);
  const resolved = await call("update_issue", { organizationSlug: "demo", issueId: "WEB-1", status: "resolved" });
  assert.equal(resolved.status, "answer", JSON.stringify(resolved));
  assert.equal(resolved.rpc.result.structuredContent.current.status, "resolved");
  const after = await call("search_issues", args);
  if (after.status !== "unsupported") {
    assert.equal(after.status, "answer", JSON.stringify(after));
    assert.deepEqual(after.rpc.result.structuredContent.issues, [], "Resolving does not create new events: an issue last seen 60 days ago remains outside a 30-day search");
  }
});
