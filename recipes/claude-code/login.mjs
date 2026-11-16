import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [directory, provider] = process.argv.slice(2);
if (!directory || !provider) throw new Error("Usage: login.mjs <box-agent-dir> <provider>");
if (provider !== "anthropic") throw new Error("The Claude Code recipe resumes sessions on Anthropic's own API only, not " + provider);
const stored = process.platform === "darwin"
  ? execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" })
  : readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json"), "utf8");
const login = JSON.parse(stored).claudeAiOauth;
if (!login?.accessToken) throw new Error("Claude Code has no claude.ai login on this machine; run claude and sign in first");
if (!(login.expiresAt > Date.now() + 15 * 60 * 1000)) throw new Error("Claude Code's login expires within 15 minutes; run claude once on this machine to refresh it, then replay again");
writeFileSync(join(directory, "credentials.json"), JSON.stringify({ claudeAiOauth: { ...login, refreshToken: "" } }), { mode: 0o600 });
