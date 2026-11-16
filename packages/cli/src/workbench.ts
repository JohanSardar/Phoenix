import { runWorkbenchCommand } from "@phoenix/workbench";

export { runWorkbenchCommand };

if (import.meta.main) {
  try { process.exitCode = await runWorkbenchCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
