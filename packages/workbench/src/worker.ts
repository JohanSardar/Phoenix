import { Runner } from "@phoenix/runner";

const [home, ledger, concurrency, replay] = process.argv.slice(2);
if (!home || !ledger || !replay) throw new Error("Usage: worker.ts <home> <ledger> <concurrency> <replay>");
try {
  const result = await new Runner({ root: home, ledger, concurrency: Number(concurrency) }).resume(replay);
  process.stdout.write(`${new Date().toISOString()} ${replay} ${result.verdict}\n`);
} catch (error) {
  process.stderr.write(`${new Date().toISOString()} ${replay} stopped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
