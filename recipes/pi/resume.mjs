import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const moment = JSON.parse(readFileSync("/phoenix/moment/moment.json", "utf8"));
const append = "/worktree/APPEND_SYSTEM.md";
const extensions = existsSync("/worktree/extensions") ? readdirSync("/worktree/extensions").filter(name => /\.(ts|js|mjs)$/.test(name)).sort().flatMap(name => ["-e", join("/worktree/extensions", name)]) : [];
const { LD_PRELOAD: _, ...env } = process.env;
const args = [
  "--fork", "/phoenix/moment/cut.jsonl", "--session-dir", "/phoenix/out",
  "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--offline",
  "-e", "/phoenix/recipe/stand-in.mjs", ...extensions,
  "--provider", moment.model.provider, "--model", moment.model.id,
  ...(moment.model.thinking ? ["--thinking", moment.model.thinking] : []),
  ...(existsSync(append) ? ["--append-system-prompt", append] : []),
  "-p", "--", moment.prompt,
];
const child = spawn("pi", args, {
  cwd: process.env.PHOENIX_PROJECT && moment.cwd && existsSync(moment.cwd) ? moment.cwd : "/worktree",
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import /phoenix/recipe/clock.mjs`.trim(), PHOENIX_CLOCK_FILE: env.FAKETIME_TIMESTAMP_FILE ?? "/phoenix-clock", PI_CODING_AGENT_DIR: "/phoenix/agent", PHOENIX_PI_LOADOUT: "/phoenix/moment/loadout.json" },
});
const code = await new Promise(resolve => child.once("close", code => resolve(code ?? 1)));
const file = readdirSync("/phoenix/out").find(name => name.endsWith(".jsonl"));
const entries = file ? readFileSync(join("/phoenix/out", file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const last = entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
const text = Array.isArray(last?.message.content) ? last.message.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
writeFileSync("/phoenix/out/result.json", JSON.stringify({ session: file ?? null, final_text: text, code }) + "\n");
process.exitCode = code;
