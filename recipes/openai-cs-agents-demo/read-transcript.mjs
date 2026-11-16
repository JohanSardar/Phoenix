import { once } from "node:events";
import { text } from "node:stream/consumers";

let seq = 0;
async function emit(kind, op, body, fields = {}, verbatim = []) {
  const event = { v: 1, capture: "transcript", stream: "session", seq: seq++, ts: { wall: fields.wall ?? "1970-01-01T00:00:00.000Z" }, kind, op, body: { inline: body }, verbatim, ...fields };
  delete event.wall;
  if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
}
await emit("meta", "transcript.coverage", JSON.stringify({
  harness_versions: ["bd7bfca0"],
  carries: ["the moment's prompt, LLM and function tools, as compose.mjs writes them"],
  lacks: ["anything the demo did live: it keeps no session"],
}));
const lines = (await text(process.stdin)).split("\n").filter(Boolean);
for (const [index, raw] of lines.entries()) {
  const entry = JSON.parse(raw);
  const line = index + 1;
  if (line === 1 && entry.cs_demo_session !== 1) await emit("meta", "transcript.unread", JSON.stringify({ line, reason: "not a session written by compose.mjs" }));
  await emit("meta", line === 1 ? "session.header" : "session.message", raw, { source_line: line, wall: new Date(entry.time).toISOString() }, ["body.inline"]);
}
await emit("close", "session.eof", "", {}, []);
