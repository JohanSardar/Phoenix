# TypeScript core, language-neutral boundaries

The core is TypeScript, run with npx, because the official MCP SDK is most mature there and most agent CLIs already launch Node tools. The trace format, moment manifest and plugin interface stay language-neutral plain files so capture recipes and plugins can be written in any language. Python (eval users) and a single Go or Rust binary (easiest install, but no mature MCP SDK) were the alternatives.
