import { execFile } from "node:child_process";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { BlobStore, writeSnapshot } from "@phoenix/store";
import type { WorkdirSnapshot } from "@phoenix/formats";
import { sanitizeMessage, secretPolicy } from "./secrets.ts";

const execute = promisify(execFile);
export async function snapshot(options: { root: string; cwd: string; run: string; home: string; started: string; copyIgnored: boolean; task?: string }) {
  const policy = await secretPolicy(options.home), blobs = new BlobStore(options.root);
  const manifest: WorkdirSnapshot = { phoenix_workdir: 1, path: options.cwd, entries: [], ignored_copied: options.copyIgnored, unread: [] };
  Object.assign(manifest, { started_at: options.started, ...(options.task ? { task: options.task } : {}) });
  const entries = new Map<string, WorkdirSnapshot["entries"][number]>();
  const git = async (...args: string[]) => (await execute("git", args, { cwd: options.cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;
  const save = async (path: string, bytes: Uint8Array, mode: string, state: WorkdirSnapshot["entries"][number]["state"]) => {
    const clean = await sanitizeMessage({ body: bytes }, policy);
    entries.set(path, { path, mode, state, blob: await blobs.put(clean.msg.body ?? new Uint8Array()), ...(clean.unscanned.length ? { secrets: "unscanned" } : {}), ...(clean.changes.length ? { secrets: clean.changes } : {}) });
  };
  const copy = async (path: string, ignored = false) => {
    const underCapture = relative(options.root, resolve(options.cwd, path));
    if (!underCapture.startsWith("..") && !underCapture.startsWith("/")) return;
    try {
      const absolute = join(options.cwd, path), before = await lstat(absolute);
      if (before.isDirectory()) return;
      if (ignored && !options.copyIgnored) { entries.set(path, { path, state: "ignored", size: before.size, mtime: before.mtime.toISOString() }); return; }
      if (!before.isFile() && !before.isSymbolicLink()) { manifest.unread.push(path); return; }
      const bytes = before.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      const after = await lstat(absolute);
      const uncertain = before.ctimeMs > Date.parse(options.started) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size;
      await save(path, bytes, before.isSymbolicLink() ? "120000" : (before.mode & 0o777).toString(8), uncertain ? "uncertain" : ignored ? "ignored-copied" : "copied");
      if (uncertain && ignored) Object.assign(entries.get(path)!, { ignored: true });
    } catch { manifest.unread.push(path); }
  };
  try { manifest.commit = (await git("rev-parse", "HEAD")).toString().trim(); } catch {}
  await writeSnapshot(options.root, options.run, { ...manifest, incomplete: true, unread: ["."] });
  try {
    if (manifest.commit) {
      for (const row of (await git("ls-tree", "-rz", manifest.commit)).toString().split("\0").filter(Boolean)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row)!;
        const [, mode, type, object, path] = match;
        if (type !== "blob") { manifest.unread.push(path!); continue; }
        try { await save(path!, await git("cat-file", "blob", object!), mode!, "committed"); } catch { manifest.unread.push(path!); }
      }
      for (const path of (await git("diff", "--no-renames", "--name-only", "--relative", "-z", manifest.commit, "--", ".")).toString().split("\0").filter(Boolean)) {
        entries.delete(path);
        try { await lstat(join(options.cwd, path)); await copy(path); } catch {}
      }
      for (const path of (await git("ls-files", "--others", "--exclude-standard", "-z")).toString().split("\0").filter(Boolean)) await copy(path);
      for (const path of (await git("ls-files", "--others", "--ignored", "--exclude-standard", "-z")).toString().split("\0").filter(Boolean)) await copy(path, true);
    } else {
      const walk = async (dir: string): Promise<void> => {
        for (const child of await readdir(dir, { withFileTypes: true })) {
          const absolute = join(dir, child.name);
          if (resolve(absolute) === resolve(options.root)) continue;
          if (child.isDirectory()) await walk(absolute); else await copy(relative(options.cwd, absolute));
        }
      };
      await walk(options.cwd);
    }
  } catch { manifest.unread.push("."); }
  manifest.entries = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  manifest.incomplete = manifest.unread.length > 0;
  await writeSnapshot(options.root, options.run, manifest);
}
