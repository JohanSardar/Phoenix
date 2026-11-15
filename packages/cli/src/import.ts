import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { digest } from "@phoenix/store";
import { importTranscript, readRecipe } from "@phoenix/transcripts";
import { transcriptCapture, transcriptOptions } from "./transcript-options.ts";

export async function runImportCommand(args: string[]): Promise<number> {
  const { values, paths } = transcriptOptions(args, ["--recipe", "--capture", "--home"]);
  if (!values["--recipe"] || paths.length !== 1) throw new Error("Usage: phoenix import --recipe <name-or-file> [--capture <id>] [--home <dir>] <path>");
  const name = values["--recipe"]!;
  let recipePath: string;
  if (name.includes("/") || /\.(json|yaml)$/.test(name)) recipePath = resolve(name);
  else {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid recipe name");
    const home = values["--home"] ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix");
    const candidates = [resolve("recipes", name, "recipe.yaml"), join(home, "recipes", name, "recipe.yaml")];
    recipePath = candidates[1]!;
    for (const candidate of candidates) {
      try { await access(candidate); recipePath = candidate; break; } catch {}
    }
  }
  const reader = await readRecipe(recipePath);
  const identity = `import-${digest(Buffer.from(JSON.stringify([reader.recipe.name, resolve(paths[0]!)]))).slice(7)}`;
  const capture = await transcriptCapture(values, identity, reader.recipe.name, reader.recipe.name);
  const result = await importTranscript({ ...capture, source: paths[0]!, reader });
  process.stdout.write(JSON.stringify({ capture: capture.root, ...result }) + "\n");
  return result.complete ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await runImportCommand(process.argv.slice(2)); }
  catch { process.stderr.write("Transcript import failed; no payloads logged\n"); process.exitCode = 1; }
}
