export type ModelDialect = "messages" | "chat-completions" | "responses" | "generate-content";

export interface ModelConfiguration {
  model: string;
  endpoint?: string;
  dialect?: ModelDialect;
  command?: readonly string[];
  cwd?: string;
  maxOutputTokens: number;
  temperature?: number;
}

export interface ModelRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  usage?: unknown;
}

export interface ModelProvider {
  readonly configuration: Readonly<ModelConfiguration>;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
