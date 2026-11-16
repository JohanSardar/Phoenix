import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [id] = process.argv.slice(2);
if (!id) throw new Error("Usage: node export.mjs <opencode-session-id> > session.jsonl");
const data = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
const bin = process.env.OPENCODE_BIN ?? (existsSync(join(homedir(), ".opencode", "bin", "opencode")) ? join(homedir(), ".opencode", "bin", "opencode") : "opencode");
const scratch = mkdtempSync(join(tmpdir(), "phoenix-opencode-export-"));
try {
  for (const part of ["data", "config", "cache", "state"]) mkdirSync(join(scratch, part, "opencode"), { recursive: true });
  for (const file of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) if (existsSync(join(data, file))) copyFileSync(join(data, file), join(scratch, "data", "opencode", file));
  const env = { ...process.env, XDG_DATA_HOME: join(scratch, "data"), XDG_CONFIG_HOME: join(scratch, "config"), XDG_CACHE_HOME: join(scratch, "cache"), XDG_STATE_HOME: join(scratch, "state"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" };
  const out = openSync(join(scratch, "export.json"), "w");
  const run = spawnSync(bin, ["export", id, "--pure"], { cwd: scratch, env, encoding: "utf8", stdio: ["ignore", out, "pipe"] });
  closeSync(out);
  if (run.status !== 0) throw new Error("opencode export failed: " + (run.stderr.trim().split("\n").at(-1) ?? run.status));
  let exported;
  try { exported = JSON.parse(readFileSync(join(scratch, "export.json"), "utf8")); } catch { throw new Error("opencode export did not print a whole session"); }
  process.stdout.write(JSON.stringify({ opencode_session: 1, info: exported.info }) + "\n");
  for (const message of exported.messages) process.stdout.write(JSON.stringify(message) + "\n");
} finally { rmSync(scratch, { recursive: true, force: true }); }
