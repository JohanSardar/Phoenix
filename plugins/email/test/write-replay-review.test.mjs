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

test("S22: a non-preview JSON read still teaches the captured body", async t => {
  const copy = await copyOf(t, cliEvents([
    { argv: list(), stdout: [envelope("10", "[phoenix-test] t57 Invoice")] },
    { argv: ["himalaya", "message", "read", "-o", "json", "10"], stdout: JSON.stringify("From: Test Person <" + me + ">\nTo: ana@example.com\nSubject: [phoenix-test] t57 Invoice\n\nInvoice due.\n") },
  ]));
  assert.match(await copy.cli(["himalaya", "message", "read", "--preview", "10"]), /Invoice due\./);
});

test("S23: real list UIDs must not identify another message's temporary UID", async t => {
  const base = envelope("10", "[phoenix-test] t57 Base");
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [base, envelope("11", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A."), b = raw("B", "Synthetic body B.", "35");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const ordered = [...list(sent), "subject", "t57", "order", "by", "date", "asc"];
  const real = JSON.parse(await source.cli(ordered));
  const aUid = real.find(message => message.subject.endsWith(" A")).id;
  assert.equal(aUid, "13");
  const copy = await copyOf(t, cliEvents([
    { argv: [...list(sent), "subject", "t57"], stdout: [base] },
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv: ordered, stdout: real },
  ]));
  await assert.rejects(() => copy.cli(["himalaya", "message", "read", "--preview", "-f", sent, aUid]), /unsupported/);
});

test("S24: a captured send without an exit is not a successful past write", async t => {
  const copy = await copyOf(t, cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Pending", "Pending body."), code: null }]));
  assert.deepEqual(JSON.parse(await copy.cli(list(sent))), []);
});

test("S25: a later MCP observation must not duplicate an earlier CLI send", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Once", plaintextBody: "Send once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S27: a later MCP unread change must win over an earlier CLI seen change", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.parse("2026-11-16T20:33:00Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Invoice", plaintextBody: "Invoice due.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const initial = [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [envelope("10", message.subject)] }]),
  ];
  const source = await copyOf(t, initial);
  await source.cli(["himalaya", "flag", "add", "10", "seen"]);
  assert.ok(JSON.parse(await source.cli(list()))[0].flags.includes("Seen"));
  await source.tool("label_message", { messageId: id, labelIds: ["UNREAD"] });
  assert.ok(!JSON.parse(await source.cli(list()))[0].flags.includes("Seen"));
  const copy = await copyOf(t, [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [envelope("10", message.subject)] }, { argv: ["himalaya", "flag", "add", "10", "seen"], stdout: "Flags successfully added!\n" }]),
    ...mcpEvents("label_message", { messageId: id, labelIds: ["UNREAD"] }, {}, "2026-11-16T20:33:50Z"),
  ]);
  assert.ok(!JSON.parse(await copy.cli(list()))[0].flags.includes("Seen"));
});

test("S26: historical envelope matching must distinguish same-minute recipients", async t => {
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [envelope("100", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A.").replace("Subject: [phoenix-test] t57 A", "Subject: [phoenix-test] t57 Same");
  const b = raw("B", "Synthetic body B.").replace("Subject: [phoenix-test] t57 B", "Subject: [phoenix-test] t57 Same").replace("To: ana@example.com", "To: ben@example.com").replace("20:34:00", "20:34:30");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const argv = [...list(sent), "subject", "t57"];
  const real = JSON.parse(await source.cli(argv));
  assert.equal(real[0].to.addr, "ben@example.com");
  assert.equal(real[0].id, "104");
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv, stdout: real },
  ]));
  await assert.rejects(() => copy.cli(["himalaya", "message", "read", "--preview", "-f", sent, real[0].id]), /unsupported/);
});

test("S28: writes observed after an explicit snapshot cut must not be applied", async t => {
  const copy = await copyOf(t, {
    account: { email: me }, cut_at: "2026-11-16T20:33:40Z",
    himalaya_output: [{ argv: ["himalaya", "message", "send"], stdin: raw("Future", "Future body."), stdout: "Message successfully sent!\n", code: 0, at: "2026-11-16T20:33:50Z" }],
  });
  assert.deepEqual(JSON.parse(await copy.cli(list(sent))), []);
});

test("S29: claiming a provisional send must reject a contradictory known body", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Claim", plaintextBody: "Different observed body.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Claim", "Original sent body."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S30: a captured JSON read of the same Message-ID must not duplicate a replayed send", async t => {
  const source = await copyOf(t, { account: { email: me } });
  const message = raw("Direct", "Read the same mail.");
  await source.cli(["himalaya", "message", "send"], message);
  const [listed] = JSON.parse(await source.cli(list(sent)));
  const read = ["himalaya", "message", "read", "--preview", "-f", sent, "-o", "json", ...["From", "To", "Subject", "Date", "Message-ID"].flatMap(name => ["-H", name]), listed.id];
  const output = await source.cli(read);
  assert.match(JSON.parse(output), /message-id:\s*<write-review-Direct@example\.com>/i);
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: message, stdout: "Message successfully sent!\n" },
    { argv: read, stdout: output },
  ]));
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S25b: a metadata observation before full content must still claim a replayed send", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const metadata = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const message = { ...metadata, subject: "[phoenix-test] t57 Once", plaintextBody: "Send once." };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "METADATA_ONLY" }, metadata, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S31: ambiguous envelope matches must not answer with extra mail", async t => {
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [envelope("100", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A.").replace("Subject: [phoenix-test] t57 A", "Subject: [phoenix-test] t57 Same");
  const b = raw("B", "Synthetic body B.").replace("Subject: [phoenix-test] t57 B", "Subject: [phoenix-test] t57 Same").replace("20:34:00", "20:34:30");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const argv = [...list(sent), "subject", "t57"];
  const real = JSON.parse(await source.cli(argv));
  assert.equal(real.length, 2);
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv, stdout: real },
  ]));
  const response = await copy.response(argv);
  if (response.status === "unsupported") return;
  assert.equal(response.status, "answer", JSON.stringify(response));
  const frames = JSON.parse(Buffer.from(response.value.body, "base64").toString());
  assert.equal(JSON.parse(Buffer.from(frames.find(frame => frame.stream === 3).bytes, "base64").toString()).code, 0);
  const stdout = frames.filter(frame => frame.stream === 1).map(frame => Buffer.from(frame.bytes, "base64").toString()).join("");
  assert.equal(JSON.parse(stdout).length, real.length);
});

test("S29b: a contradictory known HTML body must not claim another send", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Html", htmlBody: "<p>Different HTML.</p>", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const html = raw("Html", "<p>Original HTML.</p>").replace("Content-Type: text/plain; charset=utf-8", "Content-Type: text/html; charset=utf-8");
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: html, stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S32: claiming a metadata placeholder preserves a known incomplete thread count", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const replyId = ((BigInt(Date.parse("2026-11-16T20:33:43Z")) << 20n) | 1n).toString(16);
  const metadata = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const message = { ...metadata, subject: "[phoenix-test] t57 Count", plaintextBody: "Count once." };
  const reply = { id: replyId, threadId: id, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-11-16T20:33:43Z")), sender: "ana@example.com", toRecipients: [me], subject: "Re: [phoenix-test] t57 Count", snippet: "Reply" };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Count", "Count once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("search_threads", { query: "t57", view: "THREAD_VIEW_SUMMARY" }, { resultCountEstimate: "1", threads: [{ id, messageCount: 6, messages: [reply] }] }, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "METADATA_ONLY" }, metadata, "2026-11-16T20:33:46Z").map(event => ({ ...event, stream: "mcp-metadata" })),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:50Z").map(event => ({ ...event, stream: "mcp-full" })),
  ]);
  await assert.rejects(() => copy.tool("get_thread", { threadId: id, messageFormat: "METADATA_ONLY" }), /only part of thread/);
});

test("S29c: contradictory known bodies must not merge across plain and HTML formats", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Mixed", htmlBody: "<p>Different HTML body.</p>", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Mixed", "Original plaintext body."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S32b: an authoritative thread count survives a claim without a metadata placeholder", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const replyId = ((BigInt(Date.parse("2026-11-16T20:33:43Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Count", plaintextBody: "Count once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const reply = { id: replyId, threadId: id, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-11-16T20:33:43Z")), sender: "ana@example.com", toRecipients: [me], subject: "Re: [phoenix-test] t57 Count", snippet: "Reply" };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Count", "Count once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("search_threads", { query: "t57", view: "THREAD_VIEW_SUMMARY" }, { resultCountEstimate: "1", threads: [{ id, messageCount: 6, messages: [reply] }] }, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.tool("get_thread", { threadId: id, messageFormat: "METADATA_ONLY" }), /only part of thread/);
});

async function optionalList(copy, argv) {
  const response = await copy.response(argv);
  if (response.status === "unsupported") return;
  assert.equal(response.status, "answer", JSON.stringify(response));
  const frames = JSON.parse(Buffer.from(response.value.body, "base64").toString());
  const text = stream => frames.filter(frame => frame.stream === stream).map(frame => Buffer.from(frame.bytes, "base64").toString()).join("");
  assert.equal(JSON.parse(text(3)).code, 0, text(2));
  return JSON.parse(text(1));
}

test("S35: a mirrored list must not attach an unread real UID to a provisional body by content", async t => {
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [envelope("775", "[phoenix-test] unrelated")] }]));
  await source.cli(["himalaya", "message", "send"], raw("Bound", "Other recorded body.").replace("<write-review-Bound@example.com>", "<other-recorded@example.com>"));
  const argv = [...list(sent), "subject", "Bound"];
  const real = JSON.parse(await source.cli(argv));
  assert.equal(real[0].id, "777");
  const copy = await copyOf(t, cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Bound", "Provisional body."), stdout: "Message successfully sent!\n" }]));
  await copy.cli(argv, "", real);
  const response = await copy.response(["himalaya", "message", "read", "--preview", "-f", sent, real[0].id]);
  if (response.status === "answer") {
    const frames = JSON.parse(Buffer.from(response.value.body, "base64").toString());
    t.diagnostic(frames.filter(frame => frame.stream === 1).map(frame => Buffer.from(frame.bytes, "base64").toString()).join(""));
  }
  assert.equal(response.status, "unsupported");
});

test("S36: an older complete list must not erase a later move into its folder", async t => {
  const message = raw("Moved", "Moved later.");
  const source = await copyOf(t, { account: { email: me } });
  const save = ["himalaya", "message", "save", "-f", "INBOX"];
  const move = ["himalaya", "message", "move", "-f", "INBOX", sent, "1"];
  const saved = await source.cli(save, message);
  const empty = await source.cli(list(sent));
  assert.deepEqual(JSON.parse(empty), []);
  const moved = await source.cli(move);
  const query = [...list(sent), "subject", "Moved"];
  assert.equal(JSON.parse(await source.cli(query)).length, 1);
  const copy = await copyOf(t, { account: { email: me }, himalaya_output: [
    { argv: save, stdin: message, stdout: saved, code: 0, at: "2026-11-16T20:33:40Z" },
    { argv: list(sent), stdout: empty, code: 0, at: "2026-11-16T20:33:41Z" },
    { argv: move, stdout: moved, code: 0, at: "2026-11-16T20:33:42Z" },
  ] });
  const shown = await optionalList(copy, query);
  if (shown) assert.equal(shown.length, 1);
});

test("S37: a Message-ID synthesized by the copy cannot prove records different", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Same", plaintextBody: "Same body.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const first = { argv: ["himalaya", "message", "send"], stdin: raw("Same", "Same body."), stdout: "Message successfully sent!\n" };
  const seen = mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:50Z");
  const baseline = await copyOf(t, [...cliEvents([first]), ...seen]);
  await assert.rejects(() => baseline.cli(list(sent)), /unsupported/);
  const other = raw("Other", "Other body.").replace("\r\n\r\n", "\r\nIn-Reply-To: <unseen-parent@example.com>\r\n\r\n");
  const copy = await copyOf(t, [...cliEvents([first, { argv: ["himalaya", "message", "send"], stdin: other, stdout: "Message successfully sent!\n", at: "2026-11-16T20:33:55Z" }]), ...seen]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S38: IDS_ONLY search must not expose ambiguous provisional records", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Once", plaintextBody: "Send once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.tool("get_message", { messageId: id }), /unsupported/);
  await assert.rejects(() => copy.tool("search_threads", { query: "t57", view: "THREAD_VIEW_IDS_ONLY" }).then(value => { t.diagnostic(JSON.stringify(value)); return value; }), /unsupported/);
});

test("S38b: an empty search in an unsettled folder must still fall through", async t => {
  const message = raw("Self", "Self body.").replace("To: ana@example.com", "To: " + me);
  const copy = await copyOf(t, { account: { email: me }, himalaya_output: [
    { argv: ["himalaya", "message", "send"], stdin: message, stdout: "Message successfully sent!\n", code: 0, at: "2026-11-16T20:33:40Z" },
    { argv: list(sent), stdout: "[]", code: 0, at: "2026-11-16T20:33:41Z" },
  ] });
  await assert.rejects(() => copy.cli(list()), /unsupported/);
  await assert.rejects(() => copy.tool("search_threads", { query: "in:inbox" }).then(value => { t.diagnostic(JSON.stringify(value)); return value; }), /unsupported/);
});

test("S39: configured page size must not make a full page a complete folder", async t => {
  const himalaya = { accounts: [{ name: "gmail", default: true, lines: ['folder.aliases.inbox = "INBOX"', 'folder.aliases.sent = "[Gmail]/Sent Mail"', 'folder.aliases.drafts = "[Gmail]/Drafts"', 'folder.aliases.trash = "[Gmail]/Trash"', "envelope.list.page-size = 1"] }] };
  const source = await copyOf(t, { account: { email: me }, himalaya });
  const older = raw("Older", "Older body."), newer = raw("Newer", "Newer body.", "35");
  await source.cli(["himalaya", "message", "send"], older);
  await source.cli(["himalaya", "message", "send"], newer);
  const page = list(sent);
  const partial = JSON.parse(await source.cli(page));
  assert.equal(partial.length, 1);
  assert.ok(partial[0].subject.endsWith("Newer"));
  assert.equal(JSON.parse(await source.cli([...list(sent), "subject", "Older"])).length, 1);
  const copy = await copyOf(t, { account: { email: me }, himalaya, himalaya_output: [
    { argv: ["himalaya", "message", "send"], stdin: older, stdout: "Message successfully sent!\n", code: 0, at: "2026-11-16T20:33:40Z" },
    { argv: page, stdout: JSON.stringify(partial), code: 0, at: "2026-11-16T20:33:41Z" },
  ] });
  const shown = await optionalList(copy, [...list(sent), "subject", "Older"]);
  if (shown) assert.equal(shown.length, 1);
});

test("S40: separate sends without a Message-ID must get separate server-generated identities", async t => {
  const copy = await copyOf(t, { account: { email: me } });
  const message = raw("Bare", "Bare body.").replace(/^Message-ID:.*\r\n/m, "");
  await copy.cli(["himalaya", "message", "send"], message);
  assert.equal(JSON.parse(await copy.cli(list(sent))).length, 2);
  await copy.cli(["himalaya", "message", "send"], message);
  assert.equal(JSON.parse(await copy.cli(list(sent))).length, 4);
});
