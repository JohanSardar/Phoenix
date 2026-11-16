import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import traceV1 from "@phoenix/spec/schemas/trace.v1.json" with { type: "json" };
import workdirV1 from "@phoenix/spec/schemas/workdir.v1.json" with { type: "json" };
import momentV1 from "@phoenix/spec/schemas/moment.v1.json" with { type: "json" };
import fillV1 from "@phoenix/spec/schemas/fill.v1.json" with { type: "json" };
import checkV1 from "@phoenix/spec/schemas/check.v1.json" with { type: "json" };
import lockV1 from "@phoenix/spec/schemas/lock.v1.json" with { type: "json" };
import ledgerV1 from "@phoenix/spec/schemas/ledger.v1.json" with { type: "json" };
import planV1 from "@phoenix/spec/schemas/plan.v1.json" with { type: "json" };
import resultV1 from "@phoenix/spec/schemas/result.v1.json" with { type: "json" };
import harnessV1 from "@phoenix/spec/schemas/harness.v1.json" with { type: "json" };
import bindingsV1 from "@phoenix/spec/schemas/bindings.v1.json" with { type: "json" };
import recipeV1 from "@phoenix/spec/schemas/recipe.v1.json" with { type: "json" };
import pluginV1 from "@phoenix/spec/schemas/plugin.v1.json" with { type: "json" };
import madeUpV1 from "@phoenix/spec/schemas/made-up.v1.json" with { type: "json" };
import type { TraceEvent } from "./generated/trace.v1.ts";
import type { WorkdirSnapshot } from "./generated/workdir.v1.ts";
import type { MomentManifest } from "./generated/moment.v1.ts";
import type { Fill } from "./generated/fill.v1.ts";
import type { SuccessCheck } from "./generated/check.v1.ts";
import type { MomentLock } from "./generated/lock.v1.ts";
import type { LedgerEntry } from "./generated/ledger.v1.ts";
import type { ReplayPlan } from "./generated/plan.v1.ts";
import type { ReplayResult } from "./generated/result.v1.ts";
import type { HarnessContract } from "./generated/harness.v1.ts";
import type { Bindings } from "./generated/bindings.v1.ts";
import type { RecipeDescriptor } from "./generated/recipe.v1.ts";
import type { PluginDescriptor } from "./generated/plugin.v1.ts";
import type { MadeUpMoment } from "./generated/made-up.v1.ts";

export type { TraceEvent } from "./generated/trace.v1.ts";
export type { WorkdirSnapshot } from "./generated/workdir.v1.ts";
export type { MomentManifest } from "./generated/moment.v1.ts";
export type { Fill } from "./generated/fill.v1.ts";
export type { SuccessCheck } from "./generated/check.v1.ts";
export type { MomentLock } from "./generated/lock.v1.ts";
export type { LedgerEntry } from "./generated/ledger.v1.ts";
export type { ReplayPlan } from "./generated/plan.v1.ts";
export type { ReplayResult } from "./generated/result.v1.ts";
export type { HarnessContract } from "./generated/harness.v1.ts";
export type { Bindings } from "./generated/bindings.v1.ts";
export type { RecipeDescriptor } from "./generated/recipe.v1.ts";
export type { PluginDescriptor } from "./generated/plugin.v1.ts";
export type { MadeUpMoment } from "./generated/made-up.v1.ts";

export interface FormatTypes {
  trace: TraceEvent;
  workdir: WorkdirSnapshot;
  moment: MomentManifest;
  fill: Fill;
  check: SuccessCheck;
  lock: MomentLock;
  ledger: LedgerEntry;
  plan: ReplayPlan;
  result: ReplayResult;
  harness: HarnessContract;
  bindings: Bindings;
  recipe: RecipeDescriptor;
  plugin: PluginDescriptor;
  "made-up": MadeUpMoment;
}
export type FormatName = keyof FormatTypes;

export const FORMATS = {
  trace: { label: "trace event", versionField: "v", schemas: { 1: traceV1 } },
  workdir: { label: "working-directory snapshot", versionField: "phoenix_workdir", schemas: { 1: workdirV1 } },
  moment: { label: "moment manifest", versionField: "phoenix_moment", schemas: { 1: momentV1 } },
  fill: { label: "fill", versionField: "phoenix_fill", schemas: { 1: fillV1 } },
  check: { label: "success check", versionField: "phoenix_check", schemas: { 1: checkV1 } },
  lock: { label: "moment lock", versionField: "phoenix_lock", schemas: { 1: lockV1 } },
  ledger: { label: "approvals ledger entry", versionField: "phoenix_ledger", schemas: { 1: ledgerV1 } },
  plan: { label: "replay plan", versionField: "phoenix_plan", schemas: { 1: planV1 } },
  result: { label: "replay result", versionField: "phoenix_result", schemas: { 1: resultV1 } },
  harness: { label: "harness contract", versionField: "phoenix_harness", schemas: { 1: harnessV1 } },
  bindings: { label: "bindings", versionField: "phoenix_bindings", schemas: { 1: bindingsV1 } },
  recipe: { label: "recipe descriptor", versionField: "phoenix_recipe", schemas: { 1: recipeV1 } },
  plugin: { label: "plugin descriptor", versionField: "phoenix_plugin", schemas: { 1: pluginV1 } },
  "made-up": { label: "made-up moment", versionField: "phoenix_made_up", schemas: { 1: madeUpV1 } },
} as const satisfies Record<FormatName, { label: string; versionField: string; schemas: Record<number, object> }>;

export type VersionCheck = { ok: true; version: number } | { ok: false; error: string };
export type Validation<T> = { ok: true; value: T; version: number } | { ok: false; errors: string[] };

const supported = (format: FormatName) => Object.keys(FORMATS[format].schemas).map(Number);

export function checkVersion(format: FormatName, doc: unknown): VersionCheck {
  const { label, versionField } = FORMATS[format];
  const version = typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>)[versionField] : undefined;
  if (!Number.isInteger(version)) return { ok: false, error: `Not a ${label}: no integer major version in field ${versionField}.` };
  const versions = supported(format);
  if (!versions.includes(version as number))
    return { ok: false, error: `Unsupported ${label} version ${version} in field ${versionField}: this reader supports version ${versions.join(", ")}.` };
  return { ok: true, version: version as number };
}

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats.default(ajv, ["date-time"]);
const compiled = new Map<string, ValidateFunction>();

export function validate<F extends FormatName>(format: F, doc: unknown): Validation<FormatTypes[F]> {
  const version = checkVersion(format, doc);
  if (!version.ok) return { ok: false, errors: [version.error] };
  const key = `${format}.v${version.version}`;
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile((FORMATS[format].schemas as Record<number, object>)[version.version]!);
    compiled.set(key, fn);
  }
  if (fn(doc)) return { ok: true, value: doc as FormatTypes[F], version: version.version };
  return { ok: false, errors: (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}${e.params && Object.keys(e.params).length ? " " + JSON.stringify(e.params) : ""}`) };
}
