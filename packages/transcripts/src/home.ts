import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export async function secretKey(home: string): Promise<Uint8Array> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "secret-hmac.key");
  const temp = join(home, `.secret-hmac.${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    try { await file.writeFile(randomBytes(32)); await file.sync(); }
    finally { await file.close(); }
    try { await link(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const directory = await open(home, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp); }
  const key = await readFile(path);
  if (key.length < 32) throw new Error("Invalid capture secret key");
  return key;
}
