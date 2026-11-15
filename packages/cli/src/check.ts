import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { approveCheck, reviewDraft } from "@phoenix/approvals";
import { approver, confirm, phoenixHome } from "./approval-prompt.ts";
import { runCheckDraftCommand } from "./check-draft.ts";

const USAGE = "Usage: phoenix check approve [--home <dir>] [--who <name>] <moment-dir>\n       phoenix check draft --model <id> --model-endpoint <url> [--model-dialect <dialect>] [--doc <file> ...] <moment-dir>";

export async function runCheckCommand(args: string[]): Promise<number> {
  if (args[0] === "draft") return runCheckDraftCommand(args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { home: { type: "string" }, who: { type: "string" } } });
  if (positionals[0] !== "approve" || positionals.length !== 2) throw new Error(USAGE);
  const root = positionals[1]!;
  const review = await reviewDraft(root);
  const connectors = Object.fromEntries(Object.entries(review.manifest.connectors ?? {}).map(([name, c]) => [name, { tier: c.tier, read_only: c.read_only ?? [] }]));
  process.stdout.write([
    `Moment ${review.manifest.id} (${review.manifest.source}), start ${JSON.stringify(review.manifest.start ?? "mark")}`,
    "", "Check:", review.checkText.trimEnd(),
    "", "Operation classification:", stringify(connectors).trimEnd(),
    "", "Fills:", stringify(review.manifest.fills ?? []).trimEnd(), "",
  ].join("\n") + "\n");
  if (!await confirm("Approve and lock this check?")) { process.stderr.write("Not approved; nothing was locked\n"); return 1; }
  const { bundle, entry } = await approveCheck(root, { home: phoenixHome(values.home), who: approver(values.who), reviewed: review.digest });
  process.stdout.write(JSON.stringify({ locked: bundle.lockHash, ledger: entry }) + "\n");
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await runCheckCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error as Error).message + "\n"); process.exitCode = 1; }
}
