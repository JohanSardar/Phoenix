import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const schemas = join(dirname(fileURLToPath(import.meta.resolve("@phoenix/spec/package.json"))), "schemas");
const out = join(import.meta.dirname, "..", "src", "generated");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of readdirSync(schemas).filter((f) => f.endsWith(".json")).sort()) {
  const schema = JSON.parse(readFileSync(join(schemas, file), "utf8"));
  const ts = await compile(schema, schema.title, {
    additionalProperties: false,
    ignoreMinAndMaxItems: true,
    bannerComment: `// Generated from spec/schemas/${file} by packages/formats/scripts/generate.ts. Do not edit.`,
  });
  writeFileSync(join(out, file.replace(/\.json$/, ".ts")), ts);
  console.log(`generated src/generated/${file.replace(/\.json$/, ".ts")}`);
}
