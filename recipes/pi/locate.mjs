// Prints the newest pi session file for a folder: the one a live pi in that folder is writing.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { cwd: { type: "string" } } });
const cwd = resolve(values.cwd ?? process.cwd());
const directory = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
let files = [];
try { files = readdirSync(directory).filter(name => name.endsWith(".jsonl")).map(name => join(directory, name)); } catch {}
if (!files.length) throw new Error(`pi has no session for ${cwd}; pass --session <file>`);
process.stdout.write(files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] + "\n");
