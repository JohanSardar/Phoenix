import { parseArgs } from "node:util";
import { acceptPass, reviewPass } from "@phoenix/approvals";
import { approver, confirm, phoenixHome } from "./approval-prompt.ts";

const USAGE = "Usage: phoenix pass accept <result.json> --moment <id> --trace <sample-trace.jsonl> ... [--home <dir>] [--who <name>]";

export async function runPassCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    moment: { type: "string" }, trace: { type: "string", multiple: true }, home: { type: "string" }, who: { type: "string" },
  } });
  if (positionals[0] !== "accept" || positionals.length !== 2 || !values.moment || !values.trace?.length) throw new Error(USAGE);
  const home = phoenixHome(values.home), path = positionals[1]!, traces = values.trace;
  const review = await reviewPass(path, traces, values.moment, home);
  const tainted = review.result.samples.flatMap((s) => s.expectations.filter((e) => e.tainted).map((e) => ({ sample: s.sample, expectation: e.expectation, outcome: e.outcome })));
  const answers = review.synthesized.map((e) => ({ id: e.id ?? `${e.stream}:${e.seq}`, connector: e.connector, op: e.op, resolver: e.resolver, body: e.body }));
  process.stdout.write(`Discounted pass for ${values.moment} (result ${review.hash}).\n\nSynthesized answers it rests on:\n${JSON.stringify(answers, null, 2)}\n\nTainted expectations:\n${JSON.stringify(tainted, null, 2)}\n`);
  if (!await confirm("Accept this pass?")) { process.stderr.write("Not accepted; nothing was recorded\n"); return 1; }
  const entry = await acceptPass(path, { traces, moment: values.moment, home, who: approver(values.who), reviewed: review.hash });
  process.stdout.write(JSON.stringify({ ledger: entry }) + "\n");
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await runPassCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error as Error).message + "\n"); process.exitCode = 1; }
}
