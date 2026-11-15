import { parseArgs } from "node:util";
import { acceptPass, reviewPass } from "@phoenix/approvals";
import { approver, confirm, phoenixHome } from "./approval-prompt.ts";

const USAGE = "Usage: phoenix pass accept <result.json> --moment <id> [--home <dir>] [--who <name>]";

export async function runPassCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { moment: { type: "string" }, home: { type: "string" }, who: { type: "string" } } });
  if (positionals[0] !== "accept" || positionals.length !== 2 || !values.moment) throw new Error(USAGE);
  const home = phoenixHome(values.home), path = positionals[1]!;
  const review = await reviewPass(path, values.moment, home);
  const tainted = review.result.samples?.flatMap((s) => s.expectations.filter((e) => e.tainted).map((e) => ({ sample: s.sample, expectation: e.expectation, outcome: e.outcome }))) ?? [];
  process.stdout.write(`Discounted pass for ${values.moment} (result ${review.hash}). Expectations resting on synthesized answers:\n${JSON.stringify(tainted, null, 2)}\n`);
  if (!await confirm("Accept this pass?")) { process.stderr.write("Not accepted; nothing was recorded\n"); return 1; }
  const entry = await acceptPass(path, { moment: values.moment, home, who: approver(values.who), reviewed: review.hash });
  process.stdout.write(JSON.stringify({ ledger: entry }) + "\n");
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await runPassCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error as Error).message + "\n"); process.exitCode = 1; }
}
