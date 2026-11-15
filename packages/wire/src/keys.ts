import { createHash } from "node:crypto";
import type { TraceEvent } from "@phoenix/formats";
import { canonicalJson } from "./json.ts";

export type Surface = NonNullable<TraceEvent["surface"]>;
export interface KeyCall {
  surface: Surface;
  connector: string;
  op: string;
  args: unknown;
}

export function callKey(call: KeyCall): string {
  return "sha256:" + createHash("sha256").update(canonicalJson({ surface: call.surface, connector: call.connector, op: call.op, args: call.args })).digest("hex");
}

export type WriteHistories = Readonly<Record<string, readonly string[]>>;

export function completeCall(histories: WriteHistories, call: KeyCall & { readOnly: boolean }): WriteHistories {
  if (call.readOnly) return histories;
  return { ...histories, [call.connector]: [...(histories[call.connector] ?? []), callKey(call)] };
}

export function sameWriteHistory(recorded: readonly string[], current: readonly string[]): boolean {
  return recorded.length === current.length && recorded.every((key, i) => key === current[i]);
}
