import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validate, type FormatName } from "../src/index.ts";

const FILES: Record<string, FormatName> = {
  "trace.jsonl": "trace",
  "workdir.json": "workdir",
  "moment.yaml": "moment",
  "fill.json": "fill",
  "check.yaml": "check",
  "moment.lock.json": "lock",
  "ledger.jsonl": "ledger",
  "plan.json": "plan",
  "result.json": "result",
  "phoenix.harness.yaml": "harness",
  "phoenix.harness.server.yaml": "harness",
  "bindings.yaml": "bindings",
  "recipe.yaml": "recipe",
  "phoenix-plugin.json": "plugin",
};

const docs = (file: string): unknown[] => {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return [file.endsWith(".json") ? JSON.parse(text) : parse(text)];
};

const args = process.argv.slice(2);
const targets: [string, FormatName][] = args.length
  ? [[args[1]!, args[0] as FormatName]]
  : (() => {
      const dir = join(dirname(fileURLToPath(import.meta.resolve("@phoenix/spec/package.json"))), "examples");
      const found = readdirSync(dir).sort();
      const unmapped = found.filter((f) => !(f in FILES));
      if (unmapped.length) throw new Error(`No format for example files: ${unmapped.join(", ")}`);
      return found.map((f): [string, FormatName] => [join(dir, f), FILES[f]!]);
    })();

let failed = 0;
for (const [file, format] of targets) {
  docs(file).forEach((doc, i) => {
    const r = validate(format, doc);
    const name = `${file.split("/").slice(-2).join("/")}${i ? ` #${i + 1}` : ""}`;
    if (r.ok) console.log(`ok    ${format} v${r.version}  ${name}`);
    else {
      failed++;
      console.log(`FAIL  ${format}  ${name}\n      ${r.errors.join("\n      ")}`);
    }
  });
}
process.exit(failed ? 1 : 0);
