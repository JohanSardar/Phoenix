// pi-mcp-adapter hides MCP tools behind its `mcp` tool and, after a connect, behind one `mcp__<server>` tool per server.
// A call names the tool as "<server>_<tool>" and passes its arguments in `args`, as an object or a JSON string.
// These helpers turn such a call back into the server and tool it reaches, so Phoenix answers it as that server would.

export const ADAPTER = "pi-mcp-adapter";
export const METADATA = ["status", "server", "search", "describe", "instructions", "connect"];
const MODES = ["action", "connect", "describe", "instructions", "search", "server"];
const plain = name => name.replace(/[^A-Za-z0-9]/g, "_");

export const isProxy = tool => tool.name === "mcp" || (/^mcp__[^]+$/.test(tool.name) && !tool.name.slice(5).includes("__") && !!tool.parameters?.properties?.tool && !!tool.parameters?.properties?.args);

export function serverOf(proxyName, servers) {
  if (proxyName === "mcp") return undefined;
  return servers.find(server => plain(server) === proxyName.slice(5));
}

export function adapterCall(proxyName, params, adapter) {
  if (typeof params?.tool !== "string") {
    const mode = MODES.find(key => params?.[key] !== undefined) ?? "status";
    return { connector: ADAPTER, op: mode, args: params ?? {} };
  }
  let args = params.args ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return { connector: ADAPTER, op: "call", args: params }; }
  }
  const known = adapter.tools[params.tool];
  const server = serverOf(proxyName, adapter.servers) ?? known?.server ?? adapter.servers.filter(s => params.tool.startsWith(`${s}_`)).sort((a, b) => b.length - a.length)[0];
  if (!server) return { connector: ADAPTER, op: "call", args: params };
  return { connector: server, op: known?.server === server ? known.tool : params.tool.startsWith(`${server}_`) ? params.tool.slice(server.length + 1) : params.tool, args };
}
