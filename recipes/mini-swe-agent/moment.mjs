import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { at: { type: "string" }, "from-beginning": { type: "boolean" } } });
const lines = (await text(process.stdin)).split("\n").filter(Boolean).map(line => JSON.parse(line));
const [header, ...messages] = lines;
if (header?.mini_session !== 1) throw new Error("Make the session with compose.mjs");
const first = messages.findIndex(message => message.role === "user");
if (first < 0) throw new Error("The session has no prompt");
const at = first + 2;
if (!values["from-beginning"] && Number(values.at) !== at) throw new Error(`mini-swe-agent has no resume; start the moment --from-beginning (line ${at})`);
process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at, turn: at, from_beginning: true, edits: [], cut_lines: 1, prompt: messages[first].text, time: messages[first].time, cwd: header.cwd,
  model: { provider: header.llm.provider, id: header.llm.id },
  loadout: { tools: header.tools },
  answers: [],
  read_only: {},
}) + "\n");
