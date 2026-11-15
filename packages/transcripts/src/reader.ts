import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validate, type RecipeDescriptor } from "@phoenix/formats";
import { digest } from "@phoenix/store";
import type { SecretPolicy } from "@phoenix/redact";
import { importEvents, type ImportResult } from "./import.ts";

export interface InstalledReader { directory: string; recipe: RecipeDescriptor }

export async function readRecipe(path: string): Promise<InstalledReader> {
  const file = resolve(path);
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("Cannot read recipe as JSON-compatible YAML"); }
  const checked = validate("recipe", value);
  if (!checked.ok) throw new Error("Invalid recipe descriptor");
  if (!checked.value.transcript_reader) throw new Error("Recipe has no transcript reader");
  return { directory: dirname(file), recipe: checked.value };
}

export async function importTranscript(options: {
  root: string; source: string; reader: InstalledReader; policy: SecretPolicy;
  route?: "import" | "transcript";
}): Promise<ImportResult> {
  const descriptor = validate("recipe", options.reader.recipe);
  if (!descriptor.ok || !descriptor.value.transcript_reader) throw new Error("Invalid transcript reader descriptor");
  const { command, harness_versions } = descriptor.value.transcript_reader;
  const source = resolve(options.source), bytes = await readFile(source);
  const sourceDigest = digest(bytes);
  const reader = `${descriptor.value.name}.${digest(Buffer.from(JSON.stringify({ command, harness_versions }))).slice(7, 23)}`;
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.reader.directory,
    env: { ...process.env, PHOENIX_SOURCE: source },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<string | undefined>(resolve => {
    child.once("error", () => resolve("reader-start-failed"));
    child.once("exit", (code, signal) => resolve(code === 0 && !signal ? undefined : "reader-failed"));
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(bytes);
  return importEvents({ ...options, input: child.stdout, reader, sourceDigest, finish: () => exited });
}
