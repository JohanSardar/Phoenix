import { readFileSync, readdirSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

const root = resolve(import.meta.dirname, "..");

const ALLOWED: Record<string, string[]> = {
  formats: ["spec"],
  store: ["formats"],
  redact: ["formats"],
  wire: ["formats"],
  taps: ["wire", "formats"],
  capture: ["taps", "store", "redact", "plugin-host", "formats"],
  transcripts: ["store", "redact", "formats"],
  model: ["formats"],
  answer: ["wire", "store", "plugin-host", "model", "formats"],
  engine: ["taps", "answer", "store", "redact", "formats"],
  sandbox: ["formats"],
  checks: ["store", "wire", "sandbox", "formats"],
  fidelity: ["store", "wire", "formats"],
  runner: ["engine", "sandbox", "checks", "fidelity", "store", "formats"],
  approvals: ["store", "formats"],
  setup: ["store", "wire", "redact", "plugin-host", "model", "approvals", "formats"],
  workbench: ["runner", "store", "checks", "fidelity", "formats"],
  "plugin-host": ["sandbox", "formats"],
  "plugin-kit": ["plugin-host", "store", "wire", "formats"],
};
ALLOWED.cli = ["spec", ...Object.keys(ALLOWED)];

const PURE = new Set(["redact", "wire"]);
const PURE_BUILTINS = new Set(["assert", "buffer", "crypto", "path", "querystring", "string_decoder", "url", "util", "zlib"]);
const LIVE_PATH = new Set(["capture", "transcripts"]);
const LIVE_PATH_BARRED = new Set(["answer", "engine", "runner", "checks", "approvals", "workbench"]);
const VENDOR_NAMES = ["anthropic", "openai", "claude", "codex", "ozi", "slack", "notion", "googleapis", "@google/"];

const RULES: Record<string, string> = {
  "dependency-direction": "dependencies point only in the directions given in the unit table of section 2",
  "declared-dependency": "a package imports another unit only when its package.json declares it",
  "no-relative-across-units": "a relative import stays inside its own unit; import another unit by its package name",
  "static-import-paths": "import paths are string literals, so the import rules can be checked",
  "pure-no-io": "redact and wire do no I/O",
  "live-path-stays-small": "capture and transcripts and their dependencies never import answer, engine, runner, checks, approvals or workbench",
  "workbench-never-writes-checks": "workbench never imports setup or approvals",
  "packages-stay-out-of-recipes-plugins-harness": "nothing under packages/ imports from recipes/, plugins/ or reference-harness/",
  "reference-harness-no-phoenix-packages": "nothing in reference-harness/ imports from packages/",
  "plugins-and-recipes-use-only-spec": "recipes and plugins depend only on spec",
  "no-vendor-names-in-packages": "no package names a specific harness, vendor or connector; those belong in recipes and plugins",
};

type Unit = { name: string; kind: "spec" | "package" | "reference-harness" | "plugin" | "recipe"; dir: string };

const units: Unit[] = [{ name: "spec", kind: "spec", dir: join(root, "spec") }];
for (const d of readdirSync(join(root, "packages"))) units.push({ name: d, kind: "package", dir: join(root, "packages", d) });
units.push({ name: "reference-harness", kind: "reference-harness", dir: join(root, "reference-harness") });
for (const kind of ["plugin", "recipe"] as const) {
  const base = join(root, kind + "s");
  for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) units.push({ name: `${kind}:${e.name}`, kind, dir: join(base, e.name) });
}

const unitOfPath = (p: string) => units.find((u) => p === u.dir || p.startsWith(u.dir + sep));
const unitByPackage = (spec: string) => {
  const m = /^@phoenix\/([^/]+)/.exec(spec);
  if (!m) return undefined;
  return units.find((u) => (u.kind === "package" || u.kind === "spec" || u.kind === "reference-harness") && u.name === m[1]);
};

const errors: string[] = [];
const report = (where: string, rule: string, what: string) =>
  errors.push(`${where}: rule ${rule}: ${what}. Rule: ${RULES[rule]} (docs/ARCHITECTURE.md section 7).`);

const manifestDeps = (u: Unit): string[] => {
  const file = join(u.dir, "package.json");
  if (!existsSync(file)) return [];
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}));
};

function phoenixRule(from: Unit, to: Unit): string | undefined {
  if (from === to) return undefined;
  if (from.kind === "plugin" || from.kind === "recipe") return to.kind === "spec" ? undefined : "plugins-and-recipes-use-only-spec";
  if (from.kind === "reference-harness") return to.kind === "spec" ? undefined : "reference-harness-no-phoenix-packages";
  if (from.kind === "spec") return "dependency-direction";
  if (to.kind === "reference-harness") return "packages-stay-out-of-recipes-plugins-harness";
  if (from.name === "workbench" && (to.name === "setup" || to.name === "approvals")) return "workbench-never-writes-checks";
  if (LIVE_PATH.has(from.name) && LIVE_PATH_BARRED.has(to.name)) return "live-path-stays-small";
  return ALLOWED[from.name]?.includes(to.name) ? undefined : "dependency-direction";
}

function checkSpecifier(file: string, line: number, col: number, from: Unit, spec: string, declared: string[]) {
  const where = `${relative(root, file)}:${line}:${col}`;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const target = resolve(dirname(file), spec);
    const to = unitOfPath(target);
    if (to === from) return;
    if (from.kind === "package" && (!to || to.kind === "plugin" || to.kind === "recipe" || to.kind === "reference-harness") && !target.startsWith(join(root, "packages") + sep))
      return report(where, "packages-stay-out-of-recipes-plugins-harness", `"${spec}" reaches outside packages/`);
    if (from.kind === "reference-harness" && to?.kind === "package")
      return report(where, "reference-harness-no-phoenix-packages", `"${spec}" reaches into packages/`);
    return report(where, "no-relative-across-units", `"${spec}" leaves ${from.name}`);
  }
  const to = unitByPackage(spec);
  if (to) {
    const rule = phoenixRule(from, to);
    if (rule) return report(where, rule, `${from.name} imports "${spec}"`);
    if (to !== from && !declared.includes(`@phoenix/${to.name}`))
      return report(where, "declared-dependency", `"${spec}" is not in ${relative(root, join(from.dir, "package.json"))}`);
    return;
  }
  const bare = spec.replace(/^node:/, "").split("/")[0]!;
  if (PURE.has(from.name) && (spec.startsWith("node:") || builtinModules.includes(bare)) && !PURE_BUILTINS.has(bare))
    return report(where, "pure-no-io", `${from.name} imports "${spec}"`);
  if (from.kind === "package" && VENDOR_NAMES.some((v) => spec.toLowerCase().includes(v)))
    return report(where, "no-vendor-names-in-packages", `${from.name} imports "${spec}"`);
}

const SOURCE = /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/;
function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (SOURCE.test(e.name)) yield p;
  }
}

for (const unit of units) {
  const declared = manifestDeps(unit);
  for (const dep of declared) {
    const to = unitByPackage(dep);
    const rule = to && phoenixRule(unit, to);
    if (rule) report(relative(root, join(unit.dir, "package.json")), rule, `${unit.name} depends on "${dep}"`);
  }
  for (const file of sources(unit.dir)) {
    const text = readFileSync(file, "utf8");
    const pos = (offset: number) => {
      const before = text.slice(0, offset).split("\n");
      return [before.length, before.at(-1)!.length + 1] as const;
    };
    const { module, errors: parseErrors } = parseSync(file, text);
    if (parseErrors.length) errors.push(`${relative(root, file)}: could not parse: ${parseErrors[0]!.message}`);
    const requests = [
      ...module.staticImports.map((i) => i.moduleRequest),
      ...module.staticExports.flatMap((e) => e.entries.map((x) => x.moduleRequest).filter((r) => r !== null)),
    ];
    for (const r of requests) checkSpecifier(file, ...pos(r.start), unit, r.value, declared);
    for (const d of module.dynamicImports) {
      const literal = /^(["'])([^"'`]*)\1$/.exec(text.slice(d.moduleRequest.start, d.moduleRequest.end).trim());
      const [line, col] = pos(d.moduleRequest.start);
      if (literal) checkSpecifier(file, line, col, unit, literal[2]!, declared);
      else report(`${relative(root, file)}:${line}:${col}`, "static-import-paths", "dynamic import with a computed path");
    }
  }
}

for (const start of LIVE_PATH) {
  const seen = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length) {
    const name = queue.shift()!;
    const unit = units.find((u) => u.kind === "package" && u.name === name);
    if (!unit) continue;
    for (const dep of manifestDeps(unit)) {
      const to = unitByPackage(dep);
      if (!to || to.kind !== "package" || seen.has(to.name)) continue;
      const chain = [...seen.get(name)!, to.name];
      seen.set(to.name, chain);
      if (LIVE_PATH_BARRED.has(to.name)) report(`packages/${start}/package.json`, "live-path-stays-small", `${chain.join(" -> ")}`);
      queue.push(to.name);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`\n${errors.length} import rule violation${errors.length === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log(`Import rules hold across ${units.length} units.`);
