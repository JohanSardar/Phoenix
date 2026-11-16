import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-agent-dir> <provider>");
const source = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json");
const ZEN = ["opencode", "opencode-go"];
const logins = JSON.parse(readFileSync(source, "utf8"));
if (!logins[provider]) throw new Error("OpenCode has no login for " + provider + " on this machine");
const copy = {};
for (const name of new Set([provider, ...ZEN])) {
  const login = logins[name];
  if (!login) continue;
  if (login.type === "oauth" && !(login.expires > Date.now() + 15 * 60 * 1000)) throw new Error("OpenCode's " + name + " login expires within 15 minutes; run opencode once on this machine to refresh it, then replay again");
  copy[name] = login.type === "oauth" ? { ...login, refresh: "" } : login;
}
writeFileSync(join(directory, "auth.json"), JSON.stringify(copy), { mode: 0o600 });
