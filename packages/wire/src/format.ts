import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson, object } from "./json.ts";

export type InferredSchema = Record<string, unknown>;

export function inferFormat(samples: readonly unknown[]): InferredSchema {
  if (!samples.length) return {};
  const groups = new Map<string, unknown[]>();
  for (const sample of samples) {
    const type = sample === null ? "null" : Array.isArray(sample) ? "array" : typeof sample === "number" ? Number.isInteger(sample) ? "integer" : "number" : typeof sample;
    if (!["null", "array", "object", "string", "integer", "number", "boolean"].includes(type)) throw new TypeError("Format inference requires JSON values");
    groups.set(type, [...(groups.get(type) ?? []), sample]);
  }
  const variants = [...groups].map(([type, values]): InferredSchema => {
    if (type === "array") return { type, items: inferFormat(values.flatMap(v => v as unknown[])) };
    if (type !== "object") return { type };
    const records = values.map(object);
    const keys = [...new Set(records.flatMap(v => Object.keys(v)))].sort();
    return { type, properties: Object.fromEntries(keys.map(key => [key, inferFormat(records.filter(v => Object.hasOwn(v, key)).map(v => v[key]))])), required: keys.filter(key => records.every(v => Object.hasOwn(v, key))) };
  });
  return variants.length === 1 ? variants[0]! : { anyOf: variants.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) };
}

export function inferToolFormat(responses: readonly unknown[], outputSchema?: object): { schema: InferredSchema; disagreements: { sample: number; errors: string[] }[] } {
  const schema = inferFormat(responses);
  if (!outputSchema) return { schema, disagreements: [] };
  const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(outputSchema);
  return { schema, disagreements: responses.flatMap((response, sample) => validate(response) ? [] : [{ sample, errors: (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message}`) }]) };
}
