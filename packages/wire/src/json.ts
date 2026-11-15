import { canonicalize } from "json-canonicalize";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Decode<T> = { ok: true; value: T } | { ok: false; why: string; bytes: Uint8Array };

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const check = (v: unknown): void => {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "string") {
      if (!v.isWellFormed()) throw new TypeError("Canonical JSON requires Unicode scalar values");
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === null) throw new TypeError("Canonical JSON requires JSON values");
    if (active.has(v)) throw new TypeError("Canonical JSON cannot contain cycles");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      throw new TypeError("Canonical JSON requires plain objects");
    active.add(v);
    if (Array.isArray(v)) for (const item of v) check(item);
    else for (const [key, item] of Object.entries(v)) { check(key); check(item); }
    active.delete(v);
  };
  check(value);
  return canonicalize(value);
}

export function decodeJson(bytes: Uint8Array): Decode<unknown> {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, why: "Invalid UTF-8 or JSON", bytes };
  }
}

export const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
