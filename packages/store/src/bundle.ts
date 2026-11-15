import { mkdir, readFile, readdir, rename, rm, lstat, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import type { MomentManifest, MomentLock, SuccessCheck, LedgerEntry } from "@phoenix/formats";
import { atomicWrite, checked, digest, localPath, safePath, syncDirectory } from "./io.ts";

async function bundleFiles(root: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in bundle: ${path}`);
    if (entry.isDirectory()) paths.push(...await bundleFiles(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Not a plain file in bundle: ${path}`);
  }
  return paths.sort();
}

function references(manifest: MomentManifest): string[] {
  return [
    ...(manifest.workdir ? [manifest.workdir] : []),
    ...Object.values(manifest.connectors ?? {}).flatMap((c) => c.data?.map((d) => d.path) ?? []),
    ...(manifest.fills?.map((f) => f.path) ?? []),
    ...(manifest.executable ?? []),
  ];
}

export async function writeMomentBundle(root: string, bundle: {
  manifest: MomentManifest;
  files: ReadonlyMap<string, Uint8Array | string>;
  blobs?: ReadonlyMap<string, string>;
}): Promise<void> {
  checked("moment", bundle.manifest);
  const stage = join(dirname(root), `.moment-${randomUUID()}`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    await atomicWrite(join(stage, "moment.yaml"), stringify(bundle.manifest));
    for (const [path, bytes] of bundle.files) {
      if (!(path.startsWith("data/") || path.startsWith("checks/") || path === "check.draft.yaml"))
        throw new Error(`Bundle drafts cannot write ${path}; approvals owns check.yaml and moment.lock.json`);
      await atomicWrite(localPath(stage, path), bytes);
    }
    for (const [hash, source] of bundle.blobs ?? []) {
      if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid blob digest");
      if (!(await lstat(source)).isFile()) throw new Error(`Not a plain blob file: ${hash}`);
      const path = localPath(stage, `data/blobs/${hash.slice(7)}`);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await link(source, path);
      if (digest(await readFile(path)) !== hash) throw new Error(`Blob digest mismatch: ${hash}`);
      await syncDirectory(dirname(path));
    }
    for (const path of references(bundle.manifest)) await safePath(stage, path);
    try { await lstat(root); throw new Error("Moment revision already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(stage, root);
    await syncDirectory(dirname(root));
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export interface MomentBundle {
  root: string;
  manifest: MomentManifest;
  check: SuccessCheck;
  lock: MomentLock;
  lockHash: string;
  files: ReadonlyMap<string, Uint8Array>;
}

export async function readMomentBundle(root: string): Promise<MomentBundle> {
  const paths = await bundleFiles(root);
  const files = new Map<string, Uint8Array>();
  for (const path of paths) files.set(path, await readFile(await safePath(root, path)));
  const bytes = (path: string) => {
    const value = files.get(path);
    if (!value) throw new Error(`Missing bundle file: ${path}`);
    return value;
  };
  const manifest = checked("moment", parse(Buffer.from(bytes("moment.yaml")).toString()));
  const check = checked("check", parse(Buffer.from(bytes("check.yaml")).toString()));
  const lock = checked("lock", JSON.parse(Buffer.from(bytes("moment.lock.json")).toString()));
  if (lock.moment !== manifest.id) throw new Error("Lock names another moment");
  const locked = new Map<string, string>([["moment.yaml", lock.manifest], ["check.yaml", lock.check]]);
  for (const [section, hashes] of [["checks/", lock.checks], ["data/", lock.data], ["data/fills/", lock.fills]] as const) {
    for (const [path, hash] of Object.entries(hashes)) {
      localPath(root, path);
      if (!path.startsWith(section)) throw new Error(`Lock path outside ${section}: ${path}`);
      if (locked.has(path) && locked.get(path) !== hash) throw new Error(`Conflicting lock hashes: ${path}`);
      locked.set(path, hash);
    }
  }
  for (const [path, hash] of locked) {
    if (digest(bytes(path)) !== hash) throw new Error(`Bundle hash mismatch: ${path}`);
  }
  for (const path of paths) {
    if (path !== "moment.lock.json" && path !== "check.draft.yaml" && !locked.has(path))
      throw new Error(`Unhashed bundle file: ${path}`);
  }
  const checkReferences = (check.expect ?? []).flatMap((expectation) => "end_state" in expectation ? [expectation.end_state.equals] : "custom" in expectation ? [expectation.custom] : []);
  for (const path of [...references(manifest), ...checkReferences]) {
    localPath(root, path);
    if (!locked.has(path)) throw new Error(`Unhashed bundle reference: ${path}`);
  }
  for (const path of manifest.executable ?? []) {
    if (!path.startsWith("checks/")) throw new Error(`Executable outside checks/: ${path}`);
  }
  for (const expectation of check.expect ?? []) {
    if ("custom" in expectation && (!expectation.custom.startsWith("checks/") || !manifest.executable?.includes(expectation.custom)))
      throw new Error(`Custom check is not declared executable under checks/: ${expectation.custom}`);
  }
  return { root, manifest, check, lock, lockHash: digest(bytes("moment.lock.json")), files };
}

export function bundleApproval(bundle: MomentBundle, entries: readonly LedgerEntry[]): LedgerEntry {
  const entry = entries.findLast((entry) => entry.moment === bundle.manifest.id && entry.how !== "pass-accepted" && entry.lock_hash === bundle.lockHash);
  if (!entry) throw new Error(`Lock is not in approvals ledger: ${bundle.lockHash}`);
  return entry;
}
