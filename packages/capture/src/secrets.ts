import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { stripSecrets, type SecretPolicy, type WireMessage, type Change } from "@phoenix/redact";

export async function secretPolicy(home: string): Promise<SecretPolicy> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, "capture-hmac.key");
  try { await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temp = join(home, `.capture-key-${randomUUID()}`), file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(randomBytes(32)); await file.sync(); await file.close();
      try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const dir = await open(home, "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await file.close().catch(() => {}); await unlink(temp); }
  }
  return { hmacKey: await readFile(path) };
}

export async function sanitizeObject(value: unknown, policy: SecretPolicy, changes: Change[] = [], path = "body"): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v, i) => sanitizeObject(v, policy, changes, `${path}/${i}`)));
  if (!value || typeof value !== "object") return value;
  const obj = { ...value } as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === "headers" && Array.isArray(child) && child.every(v => typeof v === "string")) {
      const headers: string[] = [];
      for (let i = 0; i < child.length; i += 2) {
        const name = child[i] as string, text = child[i + 1] as string;
        const result = await stripSecrets({ headers: { [name]: text } }, policy);
        changes.push(...result.changes.map(change => ({ ...change, at: `${path}/${change.at}` })));
        headers.push(name, result.msg.headers![name] as string);
      }
      obj[key] = headers;
    } else obj[key] = await sanitizeObject(child, policy, changes, `${path}/${key}`);
  }
  return obj;
}

export async function sanitizeMessage(message: WireMessage, policy: SecretPolicy) {
  let body = message.body;
  const changes: Change[] = [];
  if (body && !message.contentEncoding) {
    try {
      const original: unknown = JSON.parse(Buffer.from(body).toString());
      const clean = await sanitizeObject(original, policy, changes);
      if (JSON.stringify(original) !== JSON.stringify(clean)) body = Buffer.from(JSON.stringify(clean));
    } catch {}
  }
  const result = await stripSecrets({ ...message, body }, policy);
  result.changes.unshift(...changes);
  return result;
}
