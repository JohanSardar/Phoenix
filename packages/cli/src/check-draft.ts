import { parseArgs } from "node:util";
import { draftCheck } from "@phoenix/setup";
import { MODEL_OPTIONS, setupProvider } from "./setup-model.ts";

const USAGE = "Usage: phoenix check draft --model <id> --model-endpoint <url> [--model-dialect <dialect>] [--doc <file> ...] [--correction <event>] <moment-dir>\n  Model request headers (credentials) come only from PHOENIX_SETUP_MODEL_HEADERS, as a JSON object.";

export async function runCheckDraftCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { doc: { type: "string", multiple: true }, correction: { type: "string" }, ...MODEL_OPTIONS } });
  const provider = setupProvider(values);
  if (!provider || positionals.length !== 1) throw new Error(USAGE);
  const { text } = await draftCheck(positionals[0]!, { provider, docs: values.doc, correction: values.correction });
  process.stdout.write(`Drafted ${positionals[0]}/check.draft.yaml:\n${text}\nEdit it if needed, then run phoenix check approve ${positionals[0]}\n`);
  return 0;
}
