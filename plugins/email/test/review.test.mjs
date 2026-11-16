import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const now = "2026-11-16T12:00:00Z";
const message = {
  id: "19a8c12345600001", threadId: "19a8c12345600001", threadCount: 1,
  subject: "[phoenix-test] original", sender: "sender@example.com",
  toRecipients: ["test@example.com"], plaintextBody: "Original body",
  internalDate: String(Date.parse(now)), labelIds: ["INBOX"],
};

async function serve(t, snapshot = {}) {
  const root = await mkdtemp(join(here, ".review-"));
  const path = join(root, "snapshot.json");
  await writeFile(path, typeof snapshot === "string" ? snapshot : JSON.stringify({ account: { email: "test@example.com" }, ...snapshot }));
  const child = spawn(process.execPath, [join(here, "../src/serve.mjs")], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PHOENIX_HIMALAYA: process.env.PHOENIX_HIMALAYA ?? "himalaya" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params) {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    const line = await lines.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value);
  }
  assert.equal((await request("initialize", { snapshot: path })).status, "answer");
  const call = async (tool, args) => {
    const raw = { jsonrpc: "2.0", id: id + 1, method: "tools/call", params: { name: tool, arguments: args } };
    return request("call", {
      surface: "mcp", layer: "agent", op: `tools/call:${tool}`, args, now,
      raw: { body: Buffer.from(JSON.stringify(raw)).toString("base64") },
    });
  };
  call.cli = argv => {
    const args = { argv: ["himalaya", ...argv], cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
    return request("call", { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: Buffer.from(JSON.stringify(args)).toString("base64") } });
  };
  return call;
}

function payload(reply) {
  assert.equal(reply.status, "answer", JSON.stringify(reply));
  const result = JSON.parse(Buffer.from(reply.value.body, "base64").toString()).result;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}

test("S2: searching unknown message content falls through", async t => {
  const { plaintextBody, threadCount, ...minimal } = message;
  const call = await serve(t, {
    answers: [{
      op: "tools/call:get_message", args: { messageId: message.id, messageFormat: "MINIMAL" },
      observed_at: now, result: { structuredContent: { ...minimal, snippet: "Only an introductory excerpt" } },
    }],
  });
  const reply = await call("search_threads", { query: "body-only-needle" });
  assert.equal(reply.status, "unsupported", JSON.stringify(reply));
});

test("S3: creating a reply draft does not make a known thread incomplete", async t => {
  const call = await serve(t, { messages: [message] });
  assert.equal(payload(await call("get_thread", { threadId: message.threadId })).messageCount, 1);
  payload(await call("create_draft", {
    replyToMessageId: message.id, to: ["sender@example.com"],
    subject: "[phoenix-test] draft", body: "Draft body",
  }));
  assert.equal((await call("get_thread", { threadId: message.threadId })).status, "answer");
});

test("S4: updating an HTML draft subject preserves its body", async t => {
  const call = await serve(t);
  const htmlBody = "<p>[phoenix-test] Keep this body</p>";
  const draft = payload(await call("create_draft", {
    to: ["test@example.com"], subject: "[phoenix-test] HTML draft", htmlBody,
  }));
  payload(await call("update_draft", { draftId: draft.id, subject: "[phoenix-test] renamed" }));
  const updated = payload(await call("get_draft", { draftId: draft.id }));
  assert.equal(updated.htmlBody, htmlBody);
});

test("S2b: metadata-only messages also make full-text search unknown", async t => {
  const call = await serve(t, {
    answers: [{
      op: "tools/call:get_message", args: { messageId: message.id, messageFormat: "METADATA_ONLY" },
      observed_at: now, result: { structuredContent: {
        id: message.id, threadId: message.threadId, labelIds: ["INBOX"],
        internalDate: message.internalDate, sender: "sender@example.com",
      } },
    }],
  });
  const reply = await call("search_threads", { query: "body-only-needle" });
  assert.equal(reply.status, "unsupported", JSON.stringify(reply));
});

test("S5: sending a new draft makes its fully known thread readable", async t => {
  const call = await serve(t);
  const draft = payload(await call("create_draft", {
    to: ["test@example.com"], subject: "[phoenix-test] send draft", body: "Draft body",
  }));
  const sent = payload(await call("send_message", { draftId: draft.id }));
  const thread = payload(await call("get_thread", { threadId: sent.threadId }));
  assert.equal(thread.messageCount, 1);
  assert.equal(thread.messages[0].plaintextBody, "Draft body");
});

test("S6: deleting a seeded label does not allow its id to be reused", async t => {
  const call = await serve(t, { labels: [{
    labelId: "Label_1", labelType: "USER", name: "[phoenix-test] old",
  }] });
  payload(await call("delete_label", { labelId: "Label_1" }));
  const created = payload(await call("create_label", { displayName: "[phoenix-test] new" }));
  assert.notEqual(created.labelId, "Label_1");
});

test("S7: renaming to another label's name falls through without changing it", async t => {
  const labels = [
    { labelId: "Label_1", labelType: "USER", name: "[phoenix-test] alpha" },
    { labelId: "Label_2", labelType: "USER", name: "[phoenix-test] beta" },
  ];
  const call = await serve(t, { labels });
  const reply = await call("update_label", { labelId: "Label_1", displayName: labels[1].name });
  assert.equal(reply.status, "unsupported", JSON.stringify(reply));
  assert.deepEqual(payload(await call("list_labels", {})).labels, labels);
});

test("S8: himalaya folder creation falls through when the label list is unknown", async t => {
  const call = await serve(t);
  const reply = await call.cli(["folder", "add", "[phoenix-test] new"]);
  const detail = reply.status === "answer"
    ? JSON.parse(Buffer.from(reply.value.body, "base64").toString()).map(f => Buffer.from(f.bytes, "base64").toString())
    : reply;
  assert.equal(reply.status, "unsupported", JSON.stringify(detail));
});

test("S9: a snapshot of capture events answers its recorded tool calls", async t => {
  const args = { messageId: message.id, messageFormat: "FULL_CONTENT" };
  const event = (seq, kind, body) => ({ v: 1, capture: "mark", stream: "mark", seq, ts: { wall: now }, kind, surface: "mcp", op: "tools/call:get_message", body: { inline: JSON.stringify(body) } });
  const events = [
    event(2, "call", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_message", arguments: args } }),
    event(3, "result", { jsonrpc: "2.0", id: 1, result: { structuredContent: message } }),
  ];
  const call = await serve(t, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(payload(await call("get_message", args)).subject, message.subject);
});
