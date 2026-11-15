import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, decodeJson, modelDialects, object, type ModelDialectName } from "@phoenix/wire";
import type { Divergence } from "./divergence.ts";

export type PrefixComparison = { ok: true; edits: string[] } | { ok: false; field: string; why: string };

export const isModelDialect = (value: string): value is ModelDialectName => Object.hasOwn(modelDialects, value);
export function resolveModelDialect(value: string): ModelDialectName | undefined {
  const unqualified = value.slice(value.indexOf("-") + 1);
  return isModelDialect(value) ? value : isModelDialect(unqualified) ? unqualified : undefined;
}

export function modelInferencePath(dialect: ModelDialectName, path: string): string {
  if (modelDialects[dialect].isInference("POST", path)) return path;
  const operation = modelDialects[dialect].inferenceOperations.find(op => modelDialects[dialect].isInference("POST", op.path.match(/^\/v[^/]+/)?.[0] + path));
  return operation ? operation.path.match(/^\/v[^/]+/)![0] + path : path;
}

export function selectModelRequest(dialect: ModelDialectName, path: string, body: Uint8Array, selection: { id: string; parameters?: Readonly<Record<string, unknown>> }): { path: string; body: Uint8Array } {
  const decoded = decodeJson(body);
  if (!decoded.ok) throw new Error("The model request is not JSON");
  const request = object(decoded.value);
  if (dialect === "generate-content") {
    request.generationConfig = { ...object(request.generationConfig), ...selection.parameters };
    path = path.replace(/\/models\/[^/:]+(?=:)/, `/models/${encodeURIComponent(selection.id)}`);
  } else Object.assign(request, selection.parameters, { model: selection.id });
  return { path, body: Buffer.from(JSON.stringify(request)) };
}

function firstDifference(a: unknown, b: unknown, path: string): string | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${path}/${i}`;
      const found = firstDifference(a[i], b[i], `${path}/${i}`);
      if (found) return found;
    }
    return undefined;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(key in a) || !(key in b)) return `${path}/${key}`;
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`);
      if (found) return found;
    }
    return undefined;
  }
  return Object.is(a, b) ? undefined : path;
}

function toolDefinitions(configuration: Record<string, unknown>): Map<string, unknown> {
  const tools = new Map<string, unknown>();
  for (const item of Array.isArray(configuration.tools) ? configuration.tools : []) {
    const tool = object(item), fn = object(tool.function);
    const declarations = Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations.map(object) : [];
    if (typeof fn.name === "string") tools.set(fn.name, fn.parameters);
    else if (typeof tool.name === "string") tools.set(tool.name, tool.input_schema ?? tool.parameters ?? tool.inputSchema);
    for (const declaration of declarations) if (typeof declaration.name === "string") tools.set(declaration.name, declaration.parameters);
  }
  return tools;
}

export function comparePrefixRequest(dialectName: ModelDialectName, recorded: Uint8Array, candidate: Uint8Array): PrefixComparison {
  const dialect = modelDialects[dialectName];
  const was = decodeJson(recorded), now = decodeJson(candidate);
  if (!was.ok) return { ok: false, field: "body", why: "the recorded model request is not JSON, so it cannot be compared" };
  if (!now.ok) return { ok: false, field: "body", why: "the model request is not JSON" };
  const before = dialect.split(object(was.value)), after = dialect.split(object(now.value));
  const changed = firstDifference(before.history, after.history, "history");
  if (changed) return { ok: false, field: changed, why: "the history differs from the recorded history" };
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const defined = toolDefinitions(after.configuration);
  for (const use of dialect.toolUses(before.history)) {
    if (!use.name || !("args" in use)) continue;
    if (!defined.has(use.name)) return { ok: false, field: `tools/${use.name}`, why: "a recorded tool call names a tool the candidate no longer defines" };
    const schema = defined.get(use.name);
    if (schema && typeof schema === "object" && !ajv.validate(schema, use.args))
      return { ok: false, field: `tools/${use.name}`, why: "a recorded tool call's arguments fail the candidate's input schema" };
  }
  const keys = [...new Set([...Object.keys(before.configuration), ...Object.keys(after.configuration)])].sort();
  const edits = keys.filter(key => {
    const a = before.configuration[key], b = after.configuration[key];
    return a === undefined || b === undefined ? a !== b : canonicalJson(a) !== canonicalJson(b);
  });
  return { ok: true, edits };
}

export function checkModelRequest(dialectName: ModelDialectName, method: string, path: string, body: Uint8Array): Divergence | undefined {
  const dialect = modelDialects[dialectName];
  if (!dialect.isInference(method, modelInferencePath(dialectName, path))) return { trigger: "not-inference", detail: `${method} ${path} is not an inference operation of the ${dialectName} dialect` };
  const decoded = decodeJson(body);
  const request = object(decoded.ok ? decoded.value : undefined);
  const external = dialect.externalAccess(request);
  if (external.length) return { trigger: "live-world", detail: "the request asks the provider to act on or fetch from outside systems", field: external[0]! };
  const state = dialect.providerState(request);
  if (state.length) return { trigger: "provider-state", detail: "the request refers to conversation state the provider holds from outside this sample", field: state[0]! };
  return undefined;
}

export type { ModelDialectName };
