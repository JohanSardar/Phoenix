import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createSessionMoment } from "@phoenix/setup";
import { digest } from "@phoenix/store";
import { importTranscript, readRecipe } from "@phoenix/transcripts";
import { transcriptCapture } from "./transcript-options.ts";

const USAGE = "Usage: phoenix moment create --session <session-file> --recipe <recipe.yaml> --at <line> --id <id> --check <check.yaml> [--timezone <tz>] [--home <dir>] <out-dir>";

export async function runMomentSessionCommand(args: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    session: { type: "string" }, recipe: { type: "string" }, at: { type: "string" }, id: { type: "string" }, check: { type: "string" }, timezone: { type: "string" }, home: { type: "string" },
  } });
  const [out, ...rest] = positionals;
  if (!out || rest.length || !v.session || !v.recipe || !v.at || !v.id || !v.check) throw new Error(USAGE);
  const reader = await readRecipe(v.recipe);
  const identity = `import-${digest(Buffer.from(JSON.stringify([reader.recipe.name, resolve(v.session)]))).slice(7)}`;
  const capture = await transcriptCapture(v.home ? { "--home": v.home } : {}, identity, reader.recipe.name, reader.recipe.name);
  const imported = await importTranscript({ ...capture, source: v.session, reader });
  if (!imported.complete) throw new Error(`The ${reader.recipe.name} transcript reader could not read all of the session: ${imported.issues.map(i => i.reason).join("; ")}`);
  const manifest = await createSessionMoment({ recipe: { directory: reader.directory, descriptor: reader.recipe }, session: v.session, capture: capture.root, at: Number(v.at), id: v.id, check: v.check, out, policy: capture.policy, ...(v.timezone ? { timezone: v.timezone } : {}) });
  process.stdout.write(JSON.stringify({ moment: manifest.id, bundle: out, resumes: manifest.resume, next: `Read ${out}/check.draft.yaml, then run phoenix check approve ${out}` }) + "\n");
  return 0;
}
