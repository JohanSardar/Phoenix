import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCapture, type CaptureMetadata } from "@phoenix/store";
import { secretKey } from "@phoenix/transcripts";

export function transcriptOptions(args: string[], valueFlags: readonly string[]): { values: Record<string, string>; paths: string[] } {
  const values: Record<string, string> = {}, paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { paths.push(arg); continue; }
    if (!valueFlags.includes(arg) || !args[i + 1] || args[i + 1]!.startsWith("--") || values[arg] !== undefined) throw new Error("Invalid transcript command options");
    values[arg] = args[++i]!;
  }
  return { values, paths };
}

export async function transcriptCapture(values: Record<string, string>, identity: string, harness: string, recipe: string) {
  const home = resolve(values["--home"] ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  const capture = values["--capture"] ?? identity;
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(capture)) throw new Error("Invalid capture id");
  const root = join(home, "captures", capture);
  const policy = { hmacKey: await secretKey(home) };
  try {
    await createCapture(root, {
      capture, harness: { name: harness, tree: "unknown" }, recipe: { name: recipe, version: "unknown" },
      routes: ["import"], started_at: new Date().toISOString(), boot_id: "unavailable",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as CaptureMetadata;
    if (metadata.capture !== capture) throw new Error("Capture id mismatch");
  }
  return { root, policy };
}
