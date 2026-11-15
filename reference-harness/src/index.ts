import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type Tool = {
  name: string;
  description?: string;
  parameters: object;
  call: (args: Record<string, unknown>) => Promise<string>;
};
type Output = {
  type: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  content?: { type: string; text?: string }[];
};

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const execute = promisify(execFile);
const clients: Client[] = [];

async function main() {
  const { values } = parseArgs({ options: { "task-file": { type: "string" } } });
  if (!values["task-file"]) throw new Error("Usage: node src/index.ts --task-file task.txt");
  const task = readFileSync(resolve(values["task-file"]), "utf8");
  const model: { baseUrlEnv: string; apiKeyEnv: string; modelEnv: string; headersEnv: string; maxTurns: number } = json("config/model.json");
  const baseUrl = process.env[model.baseUrlEnv];
  const modelId = process.env[model.modelEnv];
  if (!baseUrl || !modelId) throw new Error(`Set ${model.baseUrlEnv} and ${model.modelEnv}`);
  const apiKey = process.env[model.apiKeyEnv];
  const extraHeaders: Record<string, string> = JSON.parse(process.env[model.headersEnv] ?? "{}");
  const tools: Tool[] = [];

  const { mcpServers } = json(".mcp.json") as {
    mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  };
  for (const [server, settings] of Object.entries(mcpServers)) {
    const client = new Client({ name: "reference-harness", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ ...settings, cwd: process.cwd(), stderr: "ignore" }));
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      for (const tool of page.tools) {
        tools.push({
          name: `mcp_${server}__${tool.name}`,
          description: tool.description,
          parameters: tool.inputSchema,
          call: async (args) => JSON.stringify(await client.callTool({ name: tool.name, arguments: args })),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  const commands: { name: string; description: string; command: string; args: string[] }[] = json("tools/cli.json");
  for (const command of commands) {
    tools.push({
      name: command.name,
      description: command.description,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      call: async (args) => {
        if (Object.keys(args).length) throw new Error("This CLI tool takes no arguments");
        const result = await execute(command.command, command.args, { timeout: 10_000, maxBuffer: 1_048_576 });
        return result.stdout;
      },
    });
  }
  if (tools.some((tool) => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) || new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new Error("Tool names must be unique and contain 1–64 letters, digits, underscores or hyphens");

  const input: object[] = [{ role: "user", content: task }];
  const instructions = readFileSync("prompts/system.md", "utf8");
  for (let turn = 0; turn < model.maxTurns; turn++) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      redirect: "error",
      headers: { ...extraHeaders, "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: modelId,
        instructions,
        input,
        tools: tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters, strict: false })),
        max_output_tokens: 2048,
        store: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Model request failed (HTTP ${response.status}); response body omitted to protect credentials`);
    const body = await response.json() as { output?: Output[]; status?: string };
    if (!Array.isArray(body.output) || body.status !== "completed") throw new Error("Model did not complete a response");
    input.push(...body.output);
    const calls = body.output.filter((item) => item.type === "function_call");
    if (!calls.length) {
      const text = body.output.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n");
      if (!text) throw new Error("Model returned neither a tool call nor an answer");
      console.log(text);
      return;
    }
    for (const call of calls) {
      if (!call.call_id || !call.name) throw new Error("Model returned an invalid tool call");
      const tool = tools.find((tool) => tool.name === call.name);
      if (!tool) throw new Error("Model requested an unknown tool");
      console.error(`tool: ${tool.name}`);
      let output: string;
      try {
        const args: unknown = JSON.parse(call.arguments ?? "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
        output = await tool.call(args as Record<string, unknown>);
      } catch {
        output = JSON.stringify({ isError: true, error: "Tool failed; check the arguments and retry" });
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }
  throw new Error("Model turn limit reached");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Harness failed");
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
