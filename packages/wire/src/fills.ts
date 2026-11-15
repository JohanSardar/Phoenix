import { validate, type Fill } from "@phoenix/formats";
import { canonicalJson, object } from "./json.ts";
import type { ModelDialectName } from "./model.ts";

export interface FillLocation { evidence: string; connector?: string; at?: string }
export type FillDerivation = { ok: true; fill: Fill } | { ok: false; why: string };

function fill(item: string, rule: string, value: Fill["value"], location: FillLocation): FillDerivation {
  if (!location.evidence) return { ok: false, why: "Missing evidence location" };
  try { canonicalJson(value); } catch { return { ok: false, why: "Fill contains non-JSON values" }; }
  const result = validate("fill", {
    phoenix_fill: 1, item, tag: "derived", basis: { rule, evidence: [location.evidence] },
    producer: `wire:${rule}`, value,
    ...(location.connector === undefined ? {} : { connector: location.connector }),
    ...(location.at === undefined ? {} : { at: location.at }),
  });
  return result.ok ? { ok: true, fill: result.value } : { ok: false, why: "Invalid fill" };
}

export function deriveMcpResult(text: string, location: FillLocation, isError?: boolean): FillDerivation {
  if (typeof text !== "string" || isError !== undefined && typeof isError !== "boolean") return { ok: false, why: "Missing verbatim result text" };
  return fill("mcp.tools/call.result", "mcp-result-from-text", {
    content: [{ type: "text", text }], ...(isError === undefined ? {} : { isError }),
  }, location);
}

export function deriveToolList(request: unknown, dialect: ModelDialectName, location: FillLocation): FillDerivation {
  const definitions = object(request).tools;
  if (!Array.isArray(definitions)) return { ok: false, why: "No recorded tool definitions" };
  const tools: Record<string, unknown>[] = [];
  const add = (definition: unknown, schemaKey: string): boolean => {
    const d = object(definition), schema = object(d[schemaKey]);
    if (typeof d.name !== "string" || !d.name || schema.type !== "object" || d.description !== undefined && typeof d.description !== "string") return false;
    tools.push({ name: d.name, inputSchema: schema, ...(d.description === undefined ? {} : { description: d.description }) });
    return true;
  };
  for (const definition of definitions) {
    const d = object(definition);
    if (dialect === "messages") {
      if (d.type !== undefined && d.type !== "custom" || !add(d, "input_schema")) return { ok: false, why: "Tool has no mechanical MCP mapping" };
    } else if (dialect === "chat-completions" || dialect === "responses") {
      if (d.type !== "function" || !add(dialect === "responses" ? d : d.function, "parameters")) return { ok: false, why: "Tool has no mechanical MCP mapping" };
    } else if (dialect === "generate-content") {
      if (!Array.isArray(d.functionDeclarations) || Object.keys(d).some(key => key !== "functionDeclarations")) return { ok: false, why: "Tool has no mechanical MCP mapping" };
      for (const fn of d.functionDeclarations) if (!add(fn, "parametersJsonSchema")) return { ok: false, why: "Tool has no recorded JSON Schema" };
    } else return { ok: false, why: "Unknown model dialect" };
  }
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) return { ok: false, why: "Ambiguous tool names" };
  return fill("mcp.tools/list.result", `mcp-tool-list-from-${dialect}`, { tools }, location);
}
