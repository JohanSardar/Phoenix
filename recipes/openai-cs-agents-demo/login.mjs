import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-agent-dir> <provider>");
const source = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json");
const login = JSON.parse(readFileSync(source, "utf8"))[provider];
if (login?.type !== "api" || !login.key) throw new Error(`No API key for ${provider} on this machine; the demo uses the key OpenCode keeps`);
writeFileSync(join(directory, "llm.json"), JSON.stringify({ provider, key: login.key }), { mode: 0o600 });
