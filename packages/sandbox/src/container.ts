import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EngineChannel } from "./channel.ts";
import { clockEnvironment, classifyClockProbe, inspectElf } from "./clock.ts";
import type { Sandbox, SandboxSpec, CommandResult, ClockReport } from "./types.ts";

export class ContainerSandbox implements Sandbox {
  private cli: string[];
  private relayImage: string;
  private relayPorts: number[];
  private imageReady?: Promise<void>;

  constructor(options: { cli?: string[]; relayImage?: string; relayPorts?: number[] } = {}) {
    this.cli = options.cli ?? ["docker"];
    this.relayImage = options.relayImage ?? "phoenix-relay:1";
    this.relayPorts = options.relayPorts ?? [80, 443, 8080];
    if (!this.cli.length || this.relayPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535 || p === 53)) throw new Error("Invalid container driver options");
  }

  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.cli[0]!, [...this.cli.slice(1), ...args], { stdio: "pipe" });
  }

  private async command(args: string[], input?: string): Promise<CommandResult> {
    const child = this.spawn(args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 125, stdout, stderr }));
    });
  }

  private async require(args: string[]): Promise<string> {
    const result = await this.command(args);
    if (result.code !== 0) throw new Error(`Container command ${args[0]} failed (${result.code}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async start(spec: SandboxSpec) {
    const startedAt = Date.now();
    if (!spec.argv.length) throw new Error("Sandbox command is empty");
    const clockFile = await realpath(spec.clockFile);
    if (!(await stat(clockFile)).isFile()) throw new Error("Clock must be a regular file");
    const mountArgs: string[] = [];
    for (const mount of spec.mounts) {
      const source = await realpath(mount.source);
      const target = posix.normalize(mount.target);
      const info = await stat(source);
      if ((!info.isDirectory() && !info.isFile()) || source === homedir() || homedir().startsWith(source + "/") || source.includes(",") || target.includes(",") || !target.startsWith("/") || target === "/" || ["/run", "/proc", "/sys", "/dev", "/phoenix-clock", "/etc"].some((p) => target === p || target.startsWith(p + "/"))) throw new Error(`Unsafe sandbox mount: ${mount.source} -> ${mount.target}`);
      mountArgs.push("--mount", `type=bind,src=${source},dst=${target}${mount.readOnly ? ",readonly" : ""}`);
    }
    if (clockFile.includes(",")) throw new Error("Unsupported clock file path");
    this.imageReady ??= this.require(["build", "-t", this.relayImage, fileURLToPath(new URL("../relay", import.meta.url))]).then(() => {});
    await this.imageReady;
    const suffix = randomUUID();
    const relay = `phoenix-relay-${suffix}`;
    const workload = `phoenix-workload-${suffix}`;
    const children: ChildProcessWithoutNullStreams[] = [];
    let stopping = false;
    let stopPromise: Promise<void> | undefined;
    let channel: EngineChannel | undefined;
    const stop = (): Promise<void> => stopPromise ??= (async () => {
      stopping = true;
      channel?.close();
      await this.command(["rm", "-f", workload, relay]);
      for (const child of children) child.kill();
    })();
    try {
      const isolation = ["--cap-drop=ALL", "--security-opt=no-new-privileges", "--init"];
      const direct = spec.directHosts?.length ? ["--network", "bridge", "--cap-add=NET_ADMIN", "--env", `PHOENIX_DIRECT_HOSTS=${JSON.stringify(spec.directHosts)}`] : ["--network", "none"];
      await this.require(["run", "-d", "--name", relay, ...direct, ...isolation, "--cap-add=NET_BIND_SERVICE", "--env", `PHOENIX_RELAY_PORTS=${JSON.stringify(this.relayPorts)}`, this.relayImage]);
      await this.require(["exec", relay, "node", "-e", "const f=require('fs');let tries=0;function ready(){if(f.existsSync('/run/phoenix/engine.sock'))process.exit(0);if(++tries>100)process.exit(1);setTimeout(ready,20)}ready()"]);
      const bridge = this.spawn(["exec", "-i", relay, "node", "/relay.mjs", "bridge"]);
      children.push(bridge);
      channel = new EngineChannel(bridge.stdout, bridge.stdin);
      bridge.once("error", (error) => channel!.close(error));
      bridge.stderr.resume();
      await channel.ready;
      const env = { ...spec.env, ...clockEnvironment(spec.faketimeLibrary, spec.dontFakeMonotonic), TZ: spec.env.TZ ?? "UTC" };
      const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      await this.require(["run", "-d", "--name", workload, "--network", `container:${relay}`, ...isolation, ...mountArgs,
        "--mount", `type=bind,src=${clockFile},dst=/phoenix-clock,readonly`, ...envArgs,
        ...(spec.workdir ? ["--workdir", spec.workdir] : []), "--entrypoint", "/bin/sh", spec.image,
        "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]);
      await this.require(["exec", workload, "/bin/sh", "-c", "printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > /etc/resolv.conf"]);
      const exec = (argv: string[]) => this.command(["exec", workload, ...argv]);
      const clock: ClockReport = { clock: "unknown", binaries: [] };
      if (spec.clockProbe) {
        clock.probe = await exec(["timeout", "--signal=KILL", "10", ...spec.clockProbe]);
        if (clock.probe.code === 0 && spec.virtualTime) {
          const expected = Date.parse(spec.virtualTime) + Date.now() - startedAt;
          if (Number.isFinite(expected)) clock.clock = classifyClockProbe(clock.probe.stdout, new Date(expected).toISOString());
        }
      }
      for (const path of new Set([spec.argv[0]!, ...(spec.clockBinaries ?? [])])) {
        const result = await exec(["/bin/sh", "-c", 'p=$(command -v "$1") || exit; head -c 65536 "$p" | base64', "probe", path]);
        const kind = result.code === 0 ? inspectElf(Buffer.from(result.stdout, "base64")) : "unknown";
        clock.binaries.push({ path, clock: kind === "static" ? "real" : "unknown" });
        if (path === spec.argv[0] && kind === "static") clock.clock = "real";
      }
      let interrupt!: (error: Error) => void;
      const interrupted = new Promise<Error>((resolve) => { interrupt = resolve; });
      channel.closed.then((error) => { if (!stopping) interrupt(error); });
      for (const name of [relay, workload]) {
        const watcher = this.spawn(["wait", name]);
        children.push(watcher);
        watcher.stdout.resume();
        watcher.stderr.resume();
        watcher.once("error", (error) => { if (!stopping) interrupt(error); });
        watcher.once("close", () => { if (!stopping) interrupt(new Error(`Sandbox infrastructure stopped: ${name}`)); });
      }
      const child = this.spawn(["exec", "-i", workload, ...spec.argv]);
      children.push(child);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("error", (error) => { interrupt(error); resolve({ code: null, signal: null }); });
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const egress = () => this.command(["exec", relay, "iptables", "-L", "PHOENIX_DIRECT", "-v", "-n", "-x"]);
      return { process: { id: workload, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, interrupted, clock, exec, egress, stop }, channel };
    } catch (error) {
      await stop();
      throw error;
    }
  }
}
