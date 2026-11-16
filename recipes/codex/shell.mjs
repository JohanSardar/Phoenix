#!/usr/bin/env node
// Stands in for the user's shell inside the box. Codex runs each command as `<shell> -lc <command>`;
// Phoenix answers it from the session instead of running it.
const args = process.argv.slice(2);
const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
if (flag < 0 || args[flag + 1] === undefined) {
  process.stderr.write("Phoenix's stand-in shell only answers commands given with -c\n");
  process.exit(127);
}
const response = await fetch(`${process.env.PHOENIX_TOOLS_URL ?? "http://phoenix-tools"}/codex-shell`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "exec", arguments: { command: args[flag + 1], cwd: process.cwd() } } }),
});
const reply = await response.json();
if (reply.error) {
  process.stderr.write(`Phoenix stopped this replay: ${reply.error.message}\n`);
  process.exit(1);
}
process.stdout.write(reply.result.output ?? "");
process.exitCode = reply.result.exit_code ?? 0;
