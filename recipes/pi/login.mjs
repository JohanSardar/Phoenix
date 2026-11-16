import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-agent-dir> <provider>");
const source = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
const login = JSON.parse(readFileSync(source, "utf8"))[provider];
if (!login) throw new Error(`pi has no login for ${provider} on this machine`);
if (login.type === "oauth" && !(login.expires > Date.now() + 15 * 60 * 1000)) throw new Error(`pi's ${provider} login expires within 15 minutes; run pi once on this machine to refresh it, then replay again`);
const copy = login.type === "oauth" ? { ...login, refresh: "" } : login;
writeFileSync(join(directory, "auth.json"), JSON.stringify({ [provider]: copy }), { mode: 0o600 });
writeFileSync(join(directory, "settings.json"), "{}\n", { mode: 0o600 });
