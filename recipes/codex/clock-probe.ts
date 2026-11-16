import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "phoenix-clock-"));
await writeFile(join(home, "config.toml"), 'model="phoenix-clock-probe"\nmodel_provider="clock_probe"\n[model_providers.clock_probe]\nname="Clock probe"\nbase_url="http://127.0.0.1:1"\nenv_key="PHOENIX_CLOCK_TOKEN"\nwire_api="responses"\nsupports_websockets=false\n', { mode: 0o600 });
const child = spawn("codex", ["exec", "--skip-git-repo-check", "Clock probe; no tools"], { cwd: home, env: { ...process.env, HOME: home, CODEX_HOME: home, PHOENIX_CLOCK_TOKEN: "placeholder" }, stdio: "ignore" });
const exited = new Promise<void>(done => { child.once("exit", () => done()); child.once("error", () => done()); });
try {
  const timestamp = await new Promise<string>((done, fail) => {
    let busy = false;
    const deadline = setTimeout(() => { clearInterval(poll); fail(new Error("No native session timestamp")); }, 5000);
    const poll = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const paths = await readdir(join(home, "sessions"), { recursive: true });
          const file = paths.find(path => path.endsWith(".jsonl"));
          if (!file) return;
          const first = (await readFile(join(home, "sessions", file), "utf8")).split("\n", 1)[0];
          if (!first) return;
          const row = JSON.parse(first);
          if (row.type !== "session_meta" || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return;
          clearInterval(poll); clearTimeout(deadline); done(row.timestamp);
        } catch {} finally { busy = false; }
      })();
    }, 10);
  });
  process.stdout.write(timestamp + "\n");
} finally { child.kill("SIGTERM"); await exited; await rm(home, { recursive: true, force: true }); }
