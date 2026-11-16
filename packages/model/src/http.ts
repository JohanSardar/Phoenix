import type { ModelConfiguration, ModelProvider, ModelRequest, ModelResponse } from "./types.ts";

const record = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

export class ModelOutputError extends Error {}

export class HttpModelProvider implements ModelProvider {
  readonly configuration: Readonly<ModelConfiguration>;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(configuration: ModelConfiguration, headers: Readonly<Record<string, string>>) {
    const endpoint = new URL(configuration.endpoint);
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error("Model endpoint must be an HTTP URL without credentials, query or fragment");
    if (!configuration.model.trim() || !Number.isInteger(configuration.maxOutputTokens) || configuration.maxOutputTokens < 1)
      throw new Error("Model and positive maxOutputTokens are required");
    this.configuration = Object.freeze({ ...configuration });
    this.#headers = Object.freeze({ ...headers });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const c = this.configuration;
    const common = { ...(c.temperature === undefined ? {} : { temperature: c.temperature }) };
    let body: unknown;
    if (c.dialect === "responses") body = { ...common, model: c.model, instructions: request.system, input: [{ role: "user", content: request.prompt }], max_output_tokens: c.maxOutputTokens, store: false, stream: false };
    else if (c.dialect === "chat-completions") body = { ...common, model: c.model, messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }], max_completion_tokens: c.maxOutputTokens, stream: false };
    else if (c.dialect === "messages") body = { ...common, model: c.model, system: request.system, messages: [{ role: "user", content: request.prompt }], max_tokens: c.maxOutputTokens, stream: false };
    else body = { systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: "user", parts: [{ text: request.prompt }] }], generationConfig: { ...common, maxOutputTokens: c.maxOutputTokens } };
    const response = await fetch(c.endpoint, {
      method: "POST", headers: { ...this.#headers, "content-type": "application/json" }, body: JSON.stringify(body),
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model request failed (HTTP ${response.status})`); }
    const value = record(await response.json());
    let text: unknown;
    if (c.dialect === "responses") text = list(value.output).flatMap(item => list(record(item).content)).filter(item => record(item).type === "output_text").map(item => record(item).text).filter(t => typeof t === "string").join("");
    else if (c.dialect === "chat-completions") text = record(record(list(value.choices)[0]).message).content;
    else if (c.dialect === "messages") text = list(value.content).filter(item => record(item).type === "text").map(item => record(item).text).filter(t => typeof t === "string").join("");
    else text = list(record(record(list(value.candidates)[0]).content).parts).map(item => record(item).text).filter(t => typeof t === "string").join("");
    if (typeof text !== "string" || !text.trim()) {
      const stop = [value.status, value.stop_reason, record(list(value.choices)[0]).finish_reason, record(list(value.candidates)[0]).finishReason].find(s => typeof s === "string");
      throw new ModelOutputError(`Model response contains no text${stop ? ` (stopped: ${stop})` : ""}`);
    }
    return { text, ...(value.usage ?? value.usageMetadata ? { usage: value.usage ?? value.usageMetadata } : {}) };
  }
}
