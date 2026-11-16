// Writes a mini-swe-agent session for a made-up moment: a header line, then the prompt.
// mini-swe-agent cannot start from earlier messages, so a made-up moment for it holds only a prompt.
import { text } from "node:stream/consumers";

const made = JSON.parse(await text(process.stdin));
if (!Number.isFinite(Date.parse(made.time))) throw new Error("The made-up moment needs a time");
if (made.messages.length) throw new Error("mini-swe-agent has no resume, so a made-up moment for it starts at the prompt; leave messages empty");
const bash = made.tools.find(tool => tool.name === "bash");
const tools = [{ name: "bash", connector: bash?.connector ?? "shell", op: bash?.op ?? "bash" }];
process.stdout.write(JSON.stringify({ mini_session: 1, time: made.time, cwd: made.cwd, llm: made.llm, tools }) + "\n");
process.stdout.write(JSON.stringify({ role: "user", text: made.prompt, time: made.time }) + "\n");
