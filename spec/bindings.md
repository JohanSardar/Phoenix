# Bindings

`bindings.yaml` sits beside a moment set and joins each logical connector name to this harness's own config entry, an MCP server or a command, and says how it is served: `recorded`, or `real` to run the real server over replayed vendor traffic (ARCHITECTURE.md section 3.5). A connector with no binding binds to the MCP server or command of the same name.
