import { Readable } from "node:stream";
import { digest } from "@phoenix/store";
import { importEvents } from "@phoenix/transcripts";
import { transcriptCapture, transcriptOptions } from "./transcript-options.ts";

export async function runRecordCommand(args: string[], input: Readable = process.stdin): Promise<number> {
  const { values, paths } = transcriptOptions(args, ["--reader", "--capture", "--home"]);
  if (paths.length) throw new Error("Usage: phoenix record [--reader <name>] [--capture <id>] [--home <dir>]");
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks), sourceDigest = digest(bytes);
  const reader = values["--reader"] ?? "record";
  const capture = await transcriptCapture(values, `record-${sourceDigest.slice(7)}`, "script", reader);
  const result = await importEvents({ ...capture, reader, sourceDigest, input: Readable.from([bytes]) });
  process.stdout.write(JSON.stringify({ capture: capture.root, ...result }) + "\n");
  return result.complete ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await runRecordCommand(process.argv.slice(2)); }
  catch { process.stderr.write("Transcript recording failed; no payloads logged\n"); process.exitCode = 1; }
}
