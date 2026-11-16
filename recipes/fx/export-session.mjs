import { execFileSync } from "node:child_process";

try {
  const id = process.argv[2];
  if (!id) throw new Error("Name a saved session id");
  const version = execFileSync("fx", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const session = JSON.parse(execFileSync("fx", ["session", "--id", id, "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  process.stdout.write(JSON.stringify({ fx_version: version, session }) + "\n");
} catch {
  process.stderr.write("Could not export the saved fx session; no session content is logged\n");
  process.exitCode = 1;
}
