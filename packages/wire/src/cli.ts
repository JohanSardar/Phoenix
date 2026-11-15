import { decodeJson, encodeJson, object } from "./json.ts";

export interface TerminalSize { columns: number; rows: number }
export interface CliInvocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  terminals: { stdin: TerminalSize | null; stdout: TerminalSize | null; stderr: TerminalSize | null };
}
export type CliControl = { type: "signal"; signal: string } | { type: "resize"; fd: 0 | 1 | 2; columns: number; rows: number } | { type: "exit"; code: number | null; signal: string | null };
export const CLI_STREAM = { stdin: 0, stdout: 1, stderr: 2, control: 3 } as const;
export const encodeCliControl = (control: CliControl): Uint8Array => encodeJson(control);
export const encodeCliInvocation = (invocation: CliInvocation): Uint8Array => encodeJson(invocation);

export function decodeCliInvocation(bytes: Uint8Array): CliInvocation {
  const decoded = decodeJson(bytes);
  const v = object(decoded.ok ? decoded.value : undefined);
  const terminals = object(v.terminals);
  if (!Array.isArray(v.argv) || !v.argv.every(arg => typeof arg === "string") || typeof v.cwd !== "string" || !v.env || typeof v.env !== "object" || Array.isArray(v.env) || !Object.values(v.env).every(value => typeof value === "string") || !["stdin", "stdout", "stderr"].every(key => terminals[key] === null || Number.isInteger(object(terminals[key]).columns) && Number.isInteger(object(terminals[key]).rows)))
    throw new TypeError("Invalid CLI invocation record");
  return v as unknown as CliInvocation;
}

export function decodeCliControl(bytes: Uint8Array): CliControl {
  const decoded = decodeJson(bytes);
  const v = object(decoded.ok ? decoded.value : undefined);
  if (v.type === "signal" && typeof v.signal === "string") return v as unknown as CliControl;
  if (v.type === "resize" && [0, 1, 2].includes(v.fd as number) && Number.isInteger(v.columns) && Number.isInteger(v.rows)) return v as unknown as CliControl;
  if (v.type === "exit" && (v.code === null || Number.isInteger(v.code)) && (v.signal === null || typeof v.signal === "string") && (v.code !== null || v.signal !== null)) return v as unknown as CliControl;
  throw new TypeError("Invalid CLI control from Backend");
}

export function cliInvocation(input: Omit<CliInvocation, "env"> & { env: Record<string, string | undefined> }, allowEnv: readonly string[]): CliInvocation {
  return { ...input, argv: [...input.argv], env: Object.fromEntries(allowEnv.flatMap(key => input.env[key] === undefined ? [] : [[key, input.env[key]!]])) };
}
