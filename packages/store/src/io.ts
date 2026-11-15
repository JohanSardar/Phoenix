import { open, mkdir, rename, unlink, lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { validate, type FormatName, type FormatTypes } from "@phoenix/formats";

export const digest = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function checked<F extends FormatName>(format: F, value: unknown): FormatTypes[F] {
  const result = validate(format, value);
  if (!result.ok) throw new Error(`Invalid ${format}: ${result.errors.join("; ")}`);
  return result.value;
}

export async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, Math.min(1024 * 1024, bytes.length - offset));
    if (!bytesWritten) throw new Error("Write made no progress");
    offset += bytesWritten;
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await writeAll(file, typeof bytes === "string" ? Buffer.from(bytes) : bytes);
    await file.sync();
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  } finally { await file.close(); }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

export function localPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some((p) => p === ".." || p === "." || !p))
    throw new Error(`Path is not bundle-relative: ${path}`);
  const result = resolve(root, path);
  if (relative(resolve(root), result).startsWith("..")) throw new Error(`Path escapes bundle: ${path}`);
  return result;
}

export async function safePath(root: string, path: string): Promise<string> {
  const result = localPath(root, path);
  let cursor = resolve(root);
  const realRoot = await realpath(root);
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in bundle: ${path}`);
  }
  const rel = relative(realRoot, await realpath(result));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error(`Path escapes bundle: ${path}`);
  return result;
}
