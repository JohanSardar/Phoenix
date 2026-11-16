import { readFileSync } from "node:fs";

const loadout = JSON.parse(readFileSync(process.env.PHOENIX_OPENCODE_LOADOUT, "utf8"));
const url = process.env.PHOENIX_TOOLS_URL;
const MARK = "__phoenix_stand_in";
const CONTINUE = process.env.PHOENIX_OPENCODE_CONTINUE;

export const PhoenixStandIn = async () => {
  const builtin = new Map();
  const seen = name => {
    if (!builtin.has(name)) { let found; builtin.set(name, { ready: new Promise(resolve => { found = resolve; }), found, value: undefined }); }
    return builtin.get(name);
  };
  let next = 0;
  const tool = {};
  for (const name of loadout.tools) tool[name] = {
    description: MARK,
    args: { [MARK]: { type: "string" } },
    async execute(args, ctx) {
      const response = await fetch(url + "/opencode", {
        method: "POST",
        headers: { "content-type": "application/json", "x-phoenix-tool-call": ctx.callID ?? "" },
        body: JSON.stringify({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name, arguments: args } }),
        signal: ctx.abort,
      });
      const reply = await response.json();
      if (reply.error) throw new Error("Phoenix stopped this replay: " + reply.error.message);
      if (reply.result.isError) throw new Error(reply.result.error);
      return { output: reply.result.output, title: reply.result.title ?? "", metadata: reply.result.metadata ?? {} };
    },
  };
  return {
    tool,
    "tool.definition": async ({ toolID }, output) => {
      if (!loadout.tools.includes(toolID)) return;
      const slot = seen(toolID);
      if (output.jsonSchema?.properties?.[MARK]) {
        const original = slot.value ?? await slot.ready;
        output.description = original.description;
        output.parameters = original.parameters;
        output.jsonSchema = original.jsonSchema;
        return;
      }
      slot.value = { description: output.description, parameters: output.parameters, jsonSchema: output.jsonSchema };
      slot.found(slot.value);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!CONTINUE) return;
      const index = output.messages.findIndex(m => m.info.role === "user" && m.parts.some(p => p.type === "text" && p.text === CONTINUE));
      if (index >= 0) output.messages.splice(index, 1);
    },
  };
};
