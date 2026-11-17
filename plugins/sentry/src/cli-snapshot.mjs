#!/usr/bin/env node
// The command a mark runs for a planned sentry read (capture.reads in phoenix-plugin.json). It runs that sentry command
// line with the person's login, reading the real Sentry with GET only: route.mjs refuses every other method before it
// leaves this machine. It prints one JSON object: what the command printed, its exit code, and the Sentry API replies
// behind it, which the working copy answers from later. The login is not printed or kept.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { runCli } from "./cli.mjs";
import { token } from "./login.mjs";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
const argv = ["sentry", ...process.argv.slice(2)];
if (!descriptor.read_only.some(entry => entry.split(" ").every((word, i) => argv[i] === word))) {
  process.stderr.write(`Phoenix reads Sentry with read-only commands only, not: ${argv.join(" ")}\n`);
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "phoenix-sentry-read-"));
const log = join(scratch, "api.jsonl");
writeFileSync(log, "");
try {
  const ran = await runCli(argv.slice(1), { stdin: process.stdin.isTTY ? "" : await text(process.stdin), cwd: process.env.PHOENIX_COMMAND_CWD, token: token(), mode: "snapshot", log });
  const api = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  process.stdout.write(JSON.stringify({ stdout: ran.stdout.toString("utf8"), stderr: ran.stderr.toString("utf8"), code: ran.code, api }) + "\n");
  process.exitCode = ran.code;
} finally { rmSync(scratch, { recursive: true, force: true }); }
