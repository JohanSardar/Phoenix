#!/usr/bin/env node
import { main as captureMain } from "./capture.ts";

const USAGE = `Usage: phoenix <command> [options]

Commands:
  capture    Run a harness while recording it (--recipe <file> -- <command ...>)
  flag       Mark a moment in the current run
  mark       Mark this moment of a live harness, with nothing attached to it
  task       Start or end a task in a long-lived harness
  correct    Add a Correction to a capture
  record     Write trace events from stdin
  import     Import a harness transcript or session log
  moment     Create, pack, accept or confirm a moment
  check      Draft or approve a moment's check
  replay     Start, inspect or resume a replay
  pass       Accept a pass that rests on synthesized answers
  workbench  Serve the Workbench to an outside agent
`;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const commands: Record<string, [run: () => Promise<(args: string[]) => Promise<number>>, failure: (error: unknown) => string]> = {
  record: [async () => (await import("./record.ts")).runRecordCommand, () => "Transcript recording failed; no payloads logged"],
  import: [async () => (await import("./import.ts")).runImportCommand, () => "Transcript import failed; no payloads logged"],
  moment: [async () => (await import("./moment.ts")).runMomentCommand, message],
  mark: [async () => (await import("./mark.ts")).runMarkCommand, message],
  check: [async () => (await import("./check.ts")).runCheckCommand, message],
  replay: [async () => (await import("./replay.ts")).runReplayCommand, error => `Replay refused: ${error instanceof Error ? error.message : "unknown error"}`],
  pass: [async () => (await import("./pass.ts")).runPassCommand, message],
  workbench: [async () => (await import("./workbench.ts")).runWorkbenchCommand, message],
};

const [command, ...rest] = process.argv.slice(2);
const entry = command ? commands[command] : undefined;
if (!command || command === "--help" || command === "-h" || command === "help") {
  (command ? process.stdout : process.stderr).write(USAGE);
  if (!command) process.exitCode = 1;
} else if (entry) {
  try { process.exitCode = await (await entry[0]())(rest); }
  catch (error) { process.stderr.write(entry[1](error) + "\n"); process.exitCode = 1; }
} else {
  try { await captureMain(process.argv.slice(2)); }
  catch { process.stderr.write("Phoenix capture failed; no raw payload is logged\n"); process.exitCode = 1; }
}
