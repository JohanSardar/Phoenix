import { open } from "node:fs/promises";

export async function writeClockFile(path: string, time: string | Date): Promise<void> {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid virtual clock time");
  const offset = (date.getTime() - Date.now()) / 1000;
  let file;
  try { file = await open(path, "r+"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; file = await open(path, "wx", 0o600); }
  try {
    const contents = Buffer.from(`${offset >= 0 ? "+" : ""}${offset.toFixed(3)}s`.padEnd(127) + "\n");
    await file.write(contents, 0, contents.length, 0);
    await file.sync();
  } finally { await file.close(); }
}

export function clockEnvironment(library = "/usr/local/lib/faketime/libfaketime.so.1", dontFakeMonotonic = false): Record<string, string> {
  return {
    LD_PRELOAD: library,
    FAKETIME_TIMESTAMP_FILE: "/phoenix-clock",
    FAKETIME_NO_CACHE: "1",
    TZ: "UTC",
    ...(dontFakeMonotonic ? { FAKETIME_DONT_FAKE_MONOTONIC: "1" } : {}),
  };
}

export function classifyClockProbe(output: string, virtualTime: string): "virtual" | "real" | "unknown" {
  const text = output.trim();
  const observed = /^\d{13}$/.test(text) ? Number(text) : Date.parse(text);
  const expected = Date.parse(virtualTime);
  if (!Number.isFinite(observed) || !Number.isFinite(expected)) return "unknown";
  return Math.abs(observed - expected) < 5000 ? "virtual" : "real";
}

export function inspectElf(data: Uint8Array): "static" | "dynamic" | "unknown" {
  const b = Buffer.from(data);
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46 || ![1, 2].includes(b[4]!) || ![1, 2].includes(b[5]!)) return "unknown";
  const wide = b[4] === 2;
  const le = b[5] === 1;
  const u16 = (p: number) => le ? b.readUInt16LE(p) : b.readUInt16BE(p);
  const u32 = (p: number) => le ? b.readUInt32LE(p) : b.readUInt32BE(p);
  const offset = wide ? Number(le ? b.readBigUInt64LE(32) : b.readBigUInt64BE(32)) : u32(28);
  const size = u16(wide ? 54 : 42);
  const count = u16(wide ? 56 : 44);
  if (size < 4 || !Number.isSafeInteger(offset) || offset < 0 || offset + size * count > b.length) return "unknown";
  for (let i = 0; i < count; i++) if (u32(offset + i * size) === 3) return "dynamic";
  return count > 0 ? "static" : "unknown";
}
