import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { approveCheck, reviewDraft } from "@phoenix/approvals";
import { openRedactionDetector } from "@phoenix/redact";
import { archiveMoment, combinedDetector, packMoment, presidioDetector } from "@phoenix/setup";
import { approver, confirm, phoenixHome } from "./approval-prompt.ts";

const USAGE = "Usage: phoenix moment pack --out <packed-dir> [--archive <file.tar>] [--presidio <analyzer-url>] [--home <dir>] [--who <name>] <moment-dir>";

export async function runMomentPackCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: "string" }, archive: { type: "string" }, presidio: { type: "string" }, home: { type: "string" }, who: { type: "string" },
  } });
  if (positionals.length !== 1 || !values.out) throw new Error(USAGE);
  const detector = values.presidio ? combinedDetector([openRedactionDetector(), presidioDetector(values.presidio)]) : undefined;
  const result = await packMoment(positionals[0]!, values.out, detector ? { detector } : {});
  process.stdout.write([
    `Packed revision of ${result.manifest.id} from ${result.manifest.packed!.from} at ${values.out}`,
    "", `Scrubbed personal data at ${result.scrubbed.length} locations:`, ...result.scrubbed.map((at) => `  ${at}`),
    "", `Withheld ${result.withheld.length} bodies it could not scan:`, stringify(result.withheld).trimEnd(),
    "", "Check before packing:", result.checkBefore.trimEnd(), "", "Check after packing:", result.checkAfter.trimEnd(),
    "", `Executable content: ${(result.manifest.executable ?? []).join(", ") || "none"}`, "",
  ].join("\n") + "\n");
  const review = await reviewDraft(values.out);
  if (!await confirm("Approve and lock this packed revision?")) { process.stderr.write(`Not approved; ${values.out} stays unlocked and no archive was written\n`); return 1; }
  const { bundle, entry } = await approveCheck(values.out, { home: phoenixHome(values.home), who: approver(values.who), reviewed: review.digest });
  const archive = values.archive ?? `${values.out}.tar`;
  const paths = await archiveMoment(values.out, archive);
  process.stdout.write(JSON.stringify({ locked: bundle.lockHash, ledger: entry, archive, files: paths.length, executable: bundle.manifest.executable ?? [] }) + "\n");
  return 0;
}
