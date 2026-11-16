#!/usr/bin/env node
// Stands in for the user's shell inside the box. Codex runs each command as `<shell> -lc <command>`;
// Phoenix answers it from the session, or says to run it for real on the copy of the project's files.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
if (flag < 0 || args[flag + 1] === undefined) {
  process.stderr.write("Phoenix's stand-in shell only answers commands given with -c\n");
  process.exit(127);
}
const ask = (method, params) => fetch(`${process.env.PHOENIX_TOOLS_URL ?? "http://phoenix-tools"}/codex-shell`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: { name: "exec", ...params } }),
}).then(response => response.json());
const command = args[flag + 1];
const reply = await ask("tools/call", { arguments: { command, cwd: process.cwd() } });
if (reply.run_in_box) {
  const ran = spawnSync("/usr/local/lib/phoenix-dash", ["-c", command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = (ran.stdout ?? "") + (ran.stderr ?? "");
  await ask("phoenix/ran", { result: { content: [{ type: "text", text: output }], structuredContent: { output, exit_code: ran.status ?? 1 }, isError: ran.status !== 0 } });
  process.stdout.write(ran.stdout ?? "");
  process.stderr.write(ran.stderr ?? "");
  process.exitCode = ran.status ?? 1;
} else if (reply.error) {
  process.stderr.write(`Phoenix stopped this replay: ${reply.error.message}\n`);
  process.exitCode = 1;
} else {
  const { content, structuredContent, isError } = reply.result;
  process.stdout.write(structuredContent?.output ?? (content ?? []).map(block => block.text ?? "").join("\n"));
  process.exitCode = structuredContent?.exit_code ?? (isError ? 1 : 0);
}
