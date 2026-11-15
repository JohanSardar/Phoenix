import { HttpModelProvider, type ModelDialect, type ModelProvider } from "@phoenix/model";

export const MODEL_OPTIONS = {
  model: { type: "string" }, "model-endpoint": { type: "string" }, "model-dialect": { type: "string" },
} as const;

const DIALECTS: readonly ModelDialect[] = ["messages", "chat-completions", "responses", "generate-content"];

export function setupProvider(values: { model?: string; "model-endpoint"?: string; "model-dialect"?: string }): ModelProvider | undefined {
  if (values.model === undefined) return undefined;
  const dialect = (values["model-dialect"] ?? "responses") as ModelDialect;
  if (!values["model-endpoint"] || !DIALECTS.includes(dialect)) throw new Error(`--model needs --model-endpoint and --model-dialect ${DIALECTS.join("|")}`);
  const headers = JSON.parse(process.env.PHOENIX_SETUP_MODEL_HEADERS ?? "{}") as Record<string, string>;
  return new HttpModelProvider({ model: values.model, endpoint: values["model-endpoint"], dialect, maxOutputTokens: 8192 }, headers);
}
