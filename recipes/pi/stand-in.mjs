import { readFileSync } from "node:fs";
import { adapterCall } from "./adapter.mjs";

const loadout = JSON.parse(readFileSync(process.env.PHOENIX_PI_LOADOUT, "utf8"));
const url = process.env.PHOENIX_TOOLS_URL;
const unwrap = (name, text) => text.startsWith(`<${name}>\n`) && text.endsWith(`\n</${name}>`) ? text.slice(name.length + 3, -(name.length + 4)) : text;

export default function standIn(pi) {
  let next = 0;
  for (const tool of loadout.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
      async execute(toolCallId, params, signal) {
        const { connector, op, args } = tool.adapter?.proxy ? adapterCall(tool.name, params, loadout.adapter) : { connector: tool.connector, op: tool.op, args: params };
        const response = await fetch(`${url}/${encodeURIComponent(connector)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-phoenix-tool-call": toolCallId },
          body: JSON.stringify({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name: op, arguments: args } }),
          signal,
        });
        const reply = await response.json();
        if (reply.error) throw new Error(`Phoenix stopped this replay: ${reply.error.message}`);
        if (reply.result.isError) throw new Error(reply.result.content.map(block => block.text ?? "").join("\n"));
        return { content: reply.result.content, details: reply.result.details ?? {} };
      },
    });
  }
  const recorded = loadout.tools.map(tool => tool.name);
  const names = () => [...recorded, ...pi.getAllTools().filter(tool => tool.sourceInfo?.path?.startsWith(`${process.cwd()}/extensions/`) && !recorded.includes(tool.name)).map(tool => tool.name)];
  pi.on("session_start", () => pi.setActiveTools(names()));
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    options.selectedTools = names();
    const { preamble, ...sections } = loadout.sections;
    if (preamble !== undefined && !event.systemPrompt.startsWith(preamble)) options.customPrompt = preamble;
    for (const [name, text] of Object.entries(sections)) if (!loadout.harness_sections.includes(name)) options.sections[name] = unwrap(name, text);
  });
}
