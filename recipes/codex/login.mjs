import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || provider !== "chatgpt") throw new Error("Usage: login.mjs <box-codex-home> chatgpt");
const source = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), "utf8"));
if (source.auth_mode !== "chatgpt" || !source.tokens?.access_token) throw new Error("Codex on this machine has no ChatGPT login; run codex login, then replay again");
const expires = JSON.parse(Buffer.from(source.tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}").exp * 1000;
if (!(expires > Date.now() + 15 * 60 * 1000)) throw new Error("Codex's ChatGPT login expires within 15 minutes; run codex once on this machine to refresh it, then replay again");
writeFileSync(join(directory, "auth.json"), JSON.stringify({ ...source, tokens: { ...source.tokens, refresh_token: "" } }), { mode: 0o600 });
