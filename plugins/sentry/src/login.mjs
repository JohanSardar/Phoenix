// The person's Sentry login: the sentry CLI's stored login, or SENTRY_AUTH_TOKEN. Read at run time, never written.
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

export function token() {
  const { SENTRY_AUTH_TOKEN: given, ...env } = process.env;
  try {
    const stored = execFileSync("sentry", ["auth", "token"], { cwd: tmpdir(), env: { PATH: env.PATH ?? "", HOME: env.HOME ?? homedir() }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (stored) return stored;
  } catch {}
  if (given) return given;
  throw new Error("No Sentry login: sign in with the sentry CLI (sentry auth login) or set SENTRY_AUTH_TOKEN");
}
