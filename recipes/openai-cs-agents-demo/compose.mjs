// Writes a session for a made-up moment of the OpenAI customer service agents demo: a header line, then the prompt.
// The demo keeps no session and cannot start from earlier messages, so a made-up moment for it holds only a prompt.
import { text } from "node:stream/consumers";

const made = JSON.parse(await text(process.stdin));
if (!Number.isFinite(Date.parse(made.time))) throw new Error("The made-up moment needs a time");
if (made.messages.length) throw new Error("The demo has no resume, so a made-up moment for it starts at the prompt; leave messages empty");
const tools = made.tools.map(tool => ({ name: tool.name, connector: tool.connector, op: tool.op }));
process.stdout.write(JSON.stringify({ cs_demo_session: 1, time: made.time, cwd: made.cwd, llm: made.llm, tools }) + "\n");
process.stdout.write(JSON.stringify({ role: "user", text: made.prompt, time: made.time }) + "\n");
