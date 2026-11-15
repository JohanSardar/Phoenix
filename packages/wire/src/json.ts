export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Decode<T> = { ok: true; value: T } | { ok: false; why: string; bytes: Uint8Array };

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const serialize = (v: unknown): string => {
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") {
      if (!v.isWellFormed()) throw new TypeError("Canonical JSON requires Unicode scalar values");
      return JSON.stringify(v);
    }
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || v === null) throw new TypeError("Canonical JSON requires JSON values");
    if (active.has(v)) throw new TypeError("Canonical JSON cannot contain cycles");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw new TypeError("Canonical JSON requires plain objects");
    active.add(v);
    const result = Array.isArray(v)
      ? "[" + Array.from(v, serialize).join(",") + "]"
      : "{" + Object.keys(v).sort().map(key => `${serialize(key)}:${serialize((v as Record<string, unknown>)[key])}`).join(",") + "}";
    active.delete(v);
    return result;
  };
  return serialize(value);
}

export function decodeJson(bytes: Uint8Array): Decode<unknown> {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, why: "Invalid UTF-8 or JSON", bytes };
  }
}

export const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
