import { spawn } from "node:child_process";
import { ModelOutputError } from "./http.ts";
import type { ModelConfiguration, ModelProvider, ModelRequest, ModelResponse } from "./types.ts";

export class CommandModelProvider implements ModelProvider {
  readonly configuration: Readonly<ModelConfiguration>;

  constructor(configuration: ModelConfiguration) {
    if (!configuration.command?.length || !configuration.command[0]!.trim() || !configuration.model.trim()) throw new Error("A model command and a model name are required");
    this.configuration = Object.freeze({ ...configuration, command: Object.freeze([...configuration.command]) });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const [program, ...args] = this.configuration.command!;
    const child = spawn(program!, args, { cwd: this.configuration.cwd, stdio: ["pipe", "pipe", "pipe"], signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(`${request.system}\n\n${request.prompt}`);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (code !== 0) throw new Error(`Model command failed (exit ${code}): ${Buffer.concat(err).toString("utf8").trim().slice(-300)}`);
    const text = Buffer.concat(out).toString("utf8");
    if (!text.trim()) throw new ModelOutputError("Model command printed no text");
    return { text };
  }
}
