import { lstat, mkdir, open, readFile, readdir, rename, rm, truncate, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { validate, type FormatName, type FormatTypes, type LedgerEntry, type MomentLock, type MomentManifest, type ReplayResult, type SuccessCheck, type TraceEvent } from "@phoenix/formats";
import { BlobStore, digest, readApprovalsLedger, readJsonLines, readMomentBundle, type MomentBundle } from "@phoenix/store";

export const ledgerPath = (home: string): string => join(home, "approvals.jsonl");

function checked<F extends FormatName>(format: F, value: unknown): FormatTypes[F] {
  const result = validate(format, value);
  if (!result.ok) throw new Error(`Invalid ${format}: ${result.errors.join("; ")}`);
  return result.value;
}

async function bundleFiles(root: string, prefix = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await bundleFiles(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Not a plain file in bundle: ${path}`);
  }
  return paths.sort();
}

async function writeFileAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  catch (error) { await file.close(); await unlink(temp).catch(() => {}); throw error; }
  await file.close();
  await rename(temp, path);
}

async function appendLedger(home: string, entry: LedgerEntry): Promise<LedgerEntry> {
  checked("ledger", entry);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const existing = await readFile(ledgerPath(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0); throw error;
  });
  if (existing.length && existing.at(-1) !== 0x0a) await truncate(ledgerPath(home), existing.lastIndexOf(0x0a) + 1);
  const file = await open(ledgerPath(home), "a", 0o600);
  try { await file.writeFile(JSON.stringify(entry) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return entry;
}

async function revisionOf(home: string, moment: string, lockHash: string): Promise<string> {
  const { entries } = await readApprovalsLedger(ledgerPath(home));
  const locks = entries.filter((e) => e.moment === moment && e.how !== "pass-accepted");
  const known = locks.find((e) => e.lock_hash === lockHash);
  if (known) return known.revision;
  return String(new Set(locks.map((e) => e.lock_hash)).size + 1);
}

export interface Review {
  manifest: MomentManifest;
  check: SuccessCheck;
  checkText: string;
  hashes: { manifest: string; check: string; checks: Record<string, string>; data: Record<string, string>; fills: Record<string, string> };
  digest: string;
}

export async function reviewDraft(root: string): Promise<Review> {
  const locked = await lstat(join(root, "moment.lock.json")).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false; throw error;
  });
  if (locked) throw new Error("Moment is already locked; a change needs a new moment revision");
  const checkFile = await lstat(join(root, "check.draft.yaml")).then(() => "check.draft.yaml", () => "check.yaml");
  const manifestBytes = await readFile(join(root, "moment.yaml"));
  const checkBytes = await readFile(join(root, checkFile));
  const manifest = checked("moment", parse(manifestBytes.toString()));
  const checkText = checkBytes.toString();
  const check = checked("check", parse(checkText));
  const hashes: Review["hashes"] = { manifest: digest(manifestBytes), check: digest(checkBytes), checks: {}, data: {}, fills: {} };
  for (const path of await bundleFiles(root)) {
    if (path === "moment.yaml" || path === "check.yaml" || path === "check.draft.yaml") continue;
    const section = path.startsWith("data/fills/") ? hashes.fills : path.startsWith("data/") ? hashes.data : path.startsWith("checks/") ? hashes.checks : undefined;
    if (!section) throw new Error(`Unexpected bundle file: ${path}`);
    section[path] = digest(await readFile(join(root, path)));
  }
  return { manifest, check, checkText, hashes, digest: digest(JSON.stringify(hashes)) };
}

async function lock(root: string, how: "approved" | "auto", who: string, home: string, reviewed: string): Promise<{ bundle: MomentBundle; entry: LedgerEntry }> {
  const review = await reviewDraft(root);
  if (review.digest !== reviewed) throw new Error("Moment changed since it was reviewed; review it again");
  if (how === "auto" && review.manifest.lock !== "auto") throw new Error("Moment does not opt in to lock: auto");
  const lockFile: MomentLock = checked("lock", {
    phoenix_lock: 1, moment: review.manifest.id, ...review.hashes, how,
    ...(how === "approved" ? { approved_by: who } : {}), approved_at: new Date().toISOString(),
  });
  await writeFileAtomic(join(root, "check.yaml"), review.checkText);
  await writeFileAtomic(join(root, "moment.lock.json"), JSON.stringify(lockFile, null, 2) + "\n");
  let bundle: MomentBundle;
  try { bundle = await readMomentBundle(root); }
  catch (error) { await rm(join(root, "moment.lock.json"), { force: true }); throw error; }
  await rm(join(root, "check.draft.yaml"), { force: true });
  const entry = await appendLedger(home, {
    phoenix_ledger: 1, moment: bundle.manifest.id, revision: await revisionOf(home, bundle.manifest.id, bundle.lockHash),
    lock_hash: bundle.lockHash, how, who, at: lockFile.approved_at,
  });
  return { bundle, entry };
}

export const approveCheck = (root: string, o: { home: string; who: string; reviewed: string }) => lock(root, "approved", o.who, o.home, o.reviewed);

export async function autoLock(root: string, o: { home: string; who: string }) {
  return lock(root, "auto", o.who, o.home, (await reviewDraft(root)).digest);
}

export async function acceptMoment(root: string, o: { home: string; who: string; reviewed: string }): Promise<{ bundle: MomentBundle; entry: LedgerEntry }> {
  const bundle = await readMomentBundle(root);
  if (bundle.lockHash !== o.reviewed) throw new Error("Moment changed since it was reviewed; review it again");
  const entry = await appendLedger(o.home, {
    phoenix_ledger: 1, moment: bundle.manifest.id, revision: await revisionOf(o.home, bundle.manifest.id, bundle.lockHash),
    lock_hash: bundle.lockHash, how: "accepted", who: o.who, at: new Date().toISOString(),
  });
  return { bundle, entry };
}

export async function reviewPass(resultPath: string, traces: readonly string[], moment: string, home: string): Promise<{ result: ReplayResult; hash: string; revision: string; synthesized: TraceEvent[] }> {
  const bytes = await readFile(resultPath);
  const result = checked("result", JSON.parse(bytes.toString()));
  const ran = result.ledger_entry;
  if (ran.moment !== moment) throw new Error(`Result is for moment ${ran.moment}, not ${moment}`);
  const { entries } = await readApprovalsLedger(ledgerPath(home));
  if (!entries.some((e) => e.moment === moment && e.how !== "pass-accepted" && e.lock_hash === ran.lock_hash))
    throw new Error(`Result ran against a lock that is not in the approvals ledger: ${ran.lock_hash}`);
  if (result.verdict !== "meets-check" || !result.discount?.discounted) throw new Error("Only a discounted pass needs acceptance");
  const synthesized: TraceEvent[] = [];
  for (const trace of traces) {
    const blobs = new BlobStore(dirname(dirname(trace)));
    for (const event of (await readJsonLines(trace, (value) => checked("trace", value))).values) {
      if (event.provenance !== "synthesized") continue;
      const body = event.body && "blob" in event.body ? { inline: Buffer.from(await blobs.get(event.body.blob)).toString() } : event.body;
      synthesized.push({ ...event, ...(body ? { body } : {}) });
    }
  }
  if (!synthesized.length) throw new Error("No synthesized answers found in the sample traces; give the traces the pass rests on");
  return { result, hash: digest(bytes), revision: ran.revision, synthesized };
}

export async function acceptPass(resultPath: string, o: { traces: readonly string[]; moment: string; home: string; who: string; reviewed: string }): Promise<LedgerEntry> {
  const review = await reviewPass(resultPath, o.traces, o.moment, o.home);
  if (review.hash !== o.reviewed) throw new Error("Result changed since it was reviewed; review it again");
  return appendLedger(o.home, {
    phoenix_ledger: 1, moment: o.moment, revision: review.revision, result_hash: review.hash, how: "pass-accepted", who: o.who, at: new Date().toISOString(),
  });
}
