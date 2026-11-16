import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-home> <provider>");
if (provider !== "codex") throw new Error(`The fx recipe can resume only Codex subscription sessions, not ${provider}`);
const login = JSON.parse(readFileSync(join(homedir(), ".fx", "chatgpt-auth.json"), "utf8"));
if (!(login.expires_at_ms > Date.now() + 15 * 60 * 1000)) throw new Error("fx's Codex login expires within 15 minutes; run fx once on this machine to refresh it, then replay again");
mkdirSync(join(directory, ".fx"), { recursive: true, mode: 0o700 });
writeFileSync(join(directory, ".fx", "chatgpt-auth.json"), JSON.stringify({ ...login, refresh_token: "phoenix-box-cannot-refresh" }), { mode: 0o600 });
const settings = JSON.parse(readFileSync(join(homedir(), ".fx", "settings.json"), "utf8"));
writeFileSync(join(directory, ".fx", "settings.json"), JSON.stringify({ provider, ...(settings.permission_mode ? { permission_mode: settings.permission_mode } : {}) }), { mode: 0o600 });
