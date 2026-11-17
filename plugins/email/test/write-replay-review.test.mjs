import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const me = "me@example.com", sent = "[Gmail]/Sent Mail", now = "2026-11-16T20:34:00Z";
const b64 = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
const list = folder => ["himalaya", "envelope", "list", ...(folder ? ["-f", folder] : []), "-o", "json"];
const envelope = (id, subject) => ({ id, flags: [], subject, from: { name: "Test Person", addr: me }, to: { name: null, addr: "ana@example.com" }, date: "2026-11-16 20:33+00:00", has_attachment: false });
const raw = (name, body, minute = "34") => ["From: Test Person <" + me + ">", "To: ana@example.com", "Subject: [phoenix-test] t57 " + name, "Date: Mon, 16 Nov 2026 20:" + minute + ":00 +0000", "Message-ID: <write-review-" + name + "@example.com>", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");

function cliEvents(runs) {
  return runs.flatMap((run, n) => {
    const frames = [{ kind: "call", op: "himalaya", body: { inline: JSON.stringify({ argv: run.argv, cwd: "/synthetic", env: {}, terminals: { stdin: null, stdout: null, stderr: null } }) } }];
    if (run.stdin !== undefined) frames.push({ kind: "call", op: "frame:out:0", body: { inline: run.stdin } });
    if (run.stdout !== undefined) frames.push({ kind: "result", op: "frame:back:1", body: { inline: typeof run.stdout === "string" ? run.stdout : JSON.stringify(run.stdout) } });
    if (run.code !== null) frames.push({ kind: "result", op: "frame:back:3", body: { inline: JSON.stringify({ type: "exit", code: run.code ?? 0, signal: null }) } });
    return frames.map((frame, seq) => ({ v: 1, capture: "synthetic-write-review", connector: "email", surface: "cli", stream: "cli-" + n, seq, ts: { wall: run.at ?? "2026-11-16T20:33:" + (40 + n) + "Z" }, ...frame }));
  });
}

function mcpEvents(name, args, value, at) {
  return [
    { kind: "call", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }) } },
    { kind: "result", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { structuredContent: value } }) } },
  ].map((event, seq) => ({ v: 1, capture: "synthetic-write-review", connector: "email", surface: "mcp", stream: "mcp-" + name, seq, op: "tools/call:" + name, ts: { wall: at }, ...event }));
}

async function copyOf(t, events) {
  const root = await mkdtemp(join(import.meta.dirname, ".write-review-"));
  const snapshot = join(root, "snapshot.jsonl");
  await writeFile(snapshot, Array.isArray(events) ? events.map(event => JSON.stringify(event)).join("\n") + "\n" : JSON.stringify(events));
  const child = spawn(process.execPath, ["plugins/email/src/serve.mjs"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC", PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { const exited = once(child, "close"); child.stdin.end(); await exited; await rm(root, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const exchange = async (method, params) => {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    return JSON.parse((await lines.next()).value);
  };
  const request = async (method, params) => {
    const reply = await exchange(method, params);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    return reply.value;
  };
  await request("initialize", { snapshot });
  return {
    response: async argv => {
      const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
      return exchange("call", { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: b64("") } });
    },
    cli: async (argv, stdin = "", recorded) => {
      const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
      const params = { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: b64(stdin) } };
      if (recorded !== undefined) params.recorded = { body: b64([{ dir: "back", stream: 1, bytes: b64(recorded), last: true }]) };
      const value = await request("call", params);
      const frames = JSON.parse(Buffer.from(value.body, "base64").toString());
      const text = stream => frames.filter(frame => frame.stream === stream).map(frame => Buffer.from(frame.bytes, "base64").toString()).join("");
      assert.equal(JSON.parse(text(3)).code, 0, text(2));
      return text(1);
    },
    tool: async (name, args) => {
      const rpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } };
      const value = await request("call", { surface: "mcp", layer: "agent", op: "tools/call:" + name, args, now, raw: { body: b64(rpc) } });
      const result = JSON.parse(Buffer.from(value.body, "base64").toString()).result;
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    },
  };
}

test("S22: a past JSON read without --preview marks mail seen, so the copy answers nothing", async t => {
  const copy = await copyOf(t, cliEvents([
    { argv: list(), stdout: [envelope("10", "[phoenix-test] t57 Invoice")] },
    { argv: ["himalaya", "message", "read", "-o", "json", "10"], stdout: JSON.stringify("From: Test Person <" + me + ">\nTo: ana@example.com\nSubject: [phoenix-test] t57 Invoice\n\nInvoice due.\n") },
  ]));
  const response = await copy.response(["himalaya", "message", "read", "--preview", "10"]);
  assert.equal(response.status, "unsupported");
  assert.match(response.reason, /changed mail through himalaya before this moment/);
});

test("S24: a captured send without an exit still counts as a past write", async t => {
  const copy = await copyOf(t, cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Pending", "Pending body."), code: null }]));
  assert.equal((await copy.response(list(sent))).status, "unsupported");
});

test("S27: a later connector change does not make the copy answer after a past himalaya flag change", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.parse("2026-11-16T20:33:00Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Invoice", plaintextBody: "Invoice due.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [envelope("10", message.subject)] }, { argv: ["himalaya", "flag", "add", "10", "seen"], stdout: "Flags successfully added!\n" }]),
    ...mcpEvents("label_message", { messageId: id, labelIds: ["UNREAD"] }, {}, "2026-11-16T20:33:50Z"),
  ]);
  assert.equal((await copy.response(list())).status, "unsupported");
  await assert.rejects(() => copy.tool("get_message", { messageId: id }), /unsupported/);
});

test("S28: writes observed after an explicit snapshot cut must not be applied", async t => {
  const copy = await copyOf(t, {
    account: { email: me }, cut_at: "2026-11-16T20:33:40Z",
    himalaya_output: [{ argv: ["himalaya", "message", "send"], stdin: raw("Future", "Future body."), stdout: "Message successfully sent!\n", code: 0, at: "2026-11-16T20:33:50Z" }],
  });
  assert.deepEqual(JSON.parse(await copy.cli(list(sent))), []);
});

test("S36: after a past move, a write after the cut answers unsupported", async t => {
  const move = ["himalaya", "message", "move", "-f", "INBOX", sent, "1"];
  const copy = await copyOf(t, cliEvents([
    { argv: list(), stdout: [envelope("1", "Moved")] },
    { argv: move, stdout: "Message(s) successfully moved from INBOX to [Gmail]/Sent Mail!\n" },
  ]));
  assert.equal((await copy.response(move)).status, "unsupported");
});

test("S38: after a past himalaya send, a connector read and an IDS_ONLY search answer unsupported", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Once", plaintextBody: "Send once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.tool("get_message", { messageId: id }), /unsupported/);
  await assert.rejects(() => copy.tool("search_threads", { query: "t57", view: "THREAD_VIEW_IDS_ONLY" }).then(value => { t.diagnostic(JSON.stringify(value)); return value; }), /unsupported/);
});

test("S39: a past list with an option the copy doesn't know counts as a write", async t => {
  const plain = await copyOf(t, cliEvents([{ argv: list(), stdout: [envelope("10", "Known")] }]));
  assert.deepEqual(JSON.parse(await plain.cli(list())).map(e => e.subject), ["Known"]);
  const odd = await copyOf(t, cliEvents([{ argv: [...list(), "--frobnicate"], stdout: [envelope("10", "Known")] }]));
  assert.equal((await odd.response(list())).status, "unsupported");
});

test("S40: separate sends without a Message-ID must get separate server-generated identities", async t => {
  const copy = await copyOf(t, { account: { email: me } });
  const message = raw("Bare", "Bare body.").replace(/^Message-ID:.*\r\n/m, "");
  await copy.cli(["himalaya", "message", "send"], message);
  assert.equal(JSON.parse(await copy.cli(list(sent))).length, 2);
  await copy.cli(["himalaya", "message", "send"], message);
  assert.equal(JSON.parse(await copy.cli(list(sent))).length, 4);
});

test("S41: a past flag change in a folder the copy doesn't know makes every answer unsupported", async t => {
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "flag", "add", "-f", "Work", "10", "seen"], stdout: "Flags successfully added!\n" },
  ]));
  const response = await copy.response(list());
  assert.equal(response.status, "unsupported");
  assert.match(response.reason, /changed mail through himalaya before this moment/);
});

test("S45: after a past himalaya send, a connector search answers unsupported", async t => {
  const args = { query: "in:sent subject:IdOnly", view: "THREAD_VIEW_IDS_ONLY" };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("IdOnly", "Already observed thread."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("search_threads", args, { resultCountEstimate: "1", threads: [{ id: "1a1e610c0a09d5f3" }] }, "2026-11-16T20:33:41Z"),
  ]);
  await assert.rejects(() => copy.tool("search_threads", args), /unsupported/);
});

test("S47: after a past himalaya copy, a connector message answers unsupported", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-11-16T20:33:00Z")), sender: me, toRecipients: ["ana@example.com"], subject: "Copied", plaintextBody: "Copy me.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [{ ...envelope("10", "Copied"), flags: ["Seen"] }] }, { argv: ["himalaya", "message", "copy", "-f", "INBOX", sent, "10"], stdout: "Message(s) successfully copied!\n", at: "2026-11-16T20:33:41Z" }]),
  ]);
  await assert.rejects(() => copy.tool("get_message", { messageId: id, messageFormat: "METADATA_ONLY" }), /unsupported/);
});

test("S48: after a past folder deletion, the folder list answers unsupported", async t => {
  const copy = await copyOf(t, { account: { email: me }, labels: [{ labelId: "Label_1", labelType: "USER", name: "Work" }], himalaya_output: [
    { argv: ["himalaya", "folder", "delete", "-y", "Work"], stdout: "Folder Work successfully deleted!\n", code: 0, at: "2026-11-16T20:33:40Z" },
  ] });
  assert.equal((await copy.response(["himalaya", "folder", "list", "-o", "json"])).status, "unsupported");
});
