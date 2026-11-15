import { mkdtemp, readdir, lstat, copyFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { ContainerSandbox, writeClockFile, type Sandbox } from "@phoenix/sandbox";
import type { CheckEvidence } from "./evidence.ts";
import type { CustomCheck } from "./evaluate.ts";

const hooks = `import { registerHooks, isBuiltin } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (isBuiltin(specifier)) return next(specifier, context);
  const url = new URL(specifier, context.parentURL || 'file:///host/');
  if (url.protocol !== 'file:' || !url.pathname.startsWith('/checks/') && url.pathname !== '/host/run.mjs') throw new Error('Custom checks may import only built-ins and checks/ files');
  return next(url.href, context);
}});`;

async function copyChecks(source: string, target: string): Promise<void> {
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Custom check paths must not be symlinks");
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Custom check paths must not be symlinks: ${from}`);
    if (entry.isDirectory()) await copyChecks(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Custom check path is not a regular file: ${from}`);
  }
}

export function customCheckHost(options: {
  checksDirectory: string;
  workDirectory: string;
  image: string;
  sandbox?: Sandbox;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): CustomCheck {
  const sandbox = options.sandbox ?? new ContainerSandbox();
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxOutputBytes = options.maxOutputBytes ?? 1048576;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Invalid custom check limits");
  return async (path: string, evidence: CheckEvidence): Promise<boolean> => {
    if (!path.startsWith("checks/") || !path.endsWith(".ts") || posix.normalize(path) !== path || path.includes("\\") || path.includes("\0")) throw new Error("Custom check must be a TypeScript file under checks/");
    const root = await mkdtemp(join(options.workDirectory, "phoenix-check-"));
    let running: Awaited<ReturnType<Sandbox["start"]>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await copyChecks(options.checksDirectory, join(root, "checks"));
      await mkdir(join(root, "evidence"));
      await mkdir(join(root, "host"));
      await writeFile(join(root, "evidence", "sample.json"), JSON.stringify(evidence));
      await writeFile(join(root, "host", "hooks.mjs"), hooks);
      await writeFile(join(root, "host", "run.mjs"), `import * as module from ${JSON.stringify("/" + path)};
import { readFileSync } from 'node:fs';
const exports = Object.values(module);
if (exports.length !== 1 || typeof exports[0] !== 'function') throw new Error('Custom check must export exactly one function');
const passed = await exports[0](JSON.parse(readFileSync('/evidence/sample.json', 'utf8')));
if (typeof passed !== 'boolean') throw new Error('Custom check must return a boolean');
console.log('PHOENIX_CHECK_RESULT=' + JSON.stringify(passed));`);
      await writeClockFile(join(root, "clock"), "2000-01-01T00:00:00.000Z");
      running = await sandbox.start({ image: options.image, argv: ["node", "--permission", "--allow-fs-read=/checks", "--allow-fs-read=/evidence", "--allow-fs-read=/host", "--disallow-code-generation-from-strings", "--import", "/host/hooks.mjs", "/host/run.mjs"], env: {}, mounts: ["checks", "evidence", "host"].map(name => ({ source: join(root, name), target: "/" + name, readOnly: true })), clockFile: join(root, "clock") });
      const { process, channel } = running;
      void (async () => { for await (const connection of channel) connection.stream.destroy(); })().catch(() => {});
      process.stdin.end();
      let stdout = "", stderr = "", bytes = 0;
      const completion = new Promise<boolean>((resolve, reject) => {
        const read = (chunk: Buffer, output: "stdout" | "stderr") => {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) { reject(new Error("Custom check exceeded output limit")); return; }
          if (output === "stdout") stdout += chunk; else stderr += chunk;
        };
        process.stdout.on("data", chunk => read(chunk, "stdout"));
        process.stderr.on("data", chunk => read(chunk, "stderr"));
        process.exited.then(({ code }) => {
          if (code !== 0) { reject(new Error(`Custom check exited ${code}: ${stderr.trim()}`)); return; }
          const line = stdout.trim().split("\n").at(-1);
          if (line !== "PHOENIX_CHECK_RESULT=true" && line !== "PHOENIX_CHECK_RESULT=false") { reject(new Error("Custom check returned no boolean result")); return; }
          resolve(line === "PHOENIX_CHECK_RESULT=true");
        }, reject);
        process.interrupted.then(reject);
        timer = setTimeout(() => reject(new Error("Custom check exceeded time limit")), timeoutMs);
      });
      return await completion;
    } finally {
      if (timer) clearTimeout(timer);
      try { await running?.process.stop(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  };
}
