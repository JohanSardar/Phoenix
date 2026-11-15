# Reference harness

A one-task TypeScript harness: one model, three MCP calendar tools and two CLI tools. It imports only Node built-ins and the official MCP client v2, never a Phoenix package. Start with `src/index.ts`; the small `src/calendar-mcp.ts` is a JSON-RPC stdio demonstration server, not a vendor integration.

## Run

Use Node 24 or newer. From the repository root, run `pnpm install --frozen-lockfile`, then `cd reference-harness`. Set `MODEL_BASE_URL` to your provider's OpenAI Responses API base URL (without `/responses`), `MODEL_ID` to a tool-capable model, and `MODEL_API_KEY` if the endpoint requires a bearer token. Supply credentials through the process environment, never a config file.

```sh
node src/index.ts --task-file task.example.txt
```

The final answer goes to stdout; tool names go to stderr. Model HTTP errors show only the status, not a response body that could contain credentials. The harness sends non-streaming requests to the configured base URL with `/responses` appended. Each run starts from the task with an empty in-memory conversation; there are no sessions or resume files. It stops after twelve model turns rather than looping forever.

## Configuration and tools

- `config/model.json` names the endpoint, credential and model environment variables and sets the turn limit. Optional `MODEL_HEADERS` is a JSON object of additional request headers, for providers that require routing metadata. There is no hard-coded provider or endpoint.
- `.mcp.json` contains `mcpServers` entries with `command`, `args` and optional `env`. Each server is a separate stdio process, connected using `@modelcontextprotocol/client` v2. The demo speaks MCP 2025-11-25. Tool descriptions and input schemas come from each server's `tools/list`; the model sees names like `mcp_calendar__move_event`.
- `tools/calendar.json` describes `list_events`, `get_event` and `move_event`. The server writes only a local JSON calendar. On first launch it copies `data/calendar.seed.json` to `.local/calendar.json`; later processes reuse that file. For a fresh demo, point the server's `CALENDAR_FILE` environment variable at a new local path through `.mcp.json`.
- `tools/cli.json` declares the fixed argv for `date` and `cat data/preferences.txt`. The harness uses `execFile`, not a shell; the model cannot supply arbitrary commands or arguments. These processes inherit the harness environment, so use only trusted commands. PATH remains available for Phoenix's CLI shims.
- `prompts/system.md` is the calendar assistant's system prompt.

The sample task moves only the 3pm Project sync by thirty minutes. Inspect `.local/calendar.json` afterward: its duration should remain thirty minutes and the other two events should be unchanged. All calendar data is synthetic; no real service is contacted by the tools.

## Harness contract

`phoenix.harness.yaml` is the three-part contract from `spec/harness.md`: how to run the task, where endpoints are configured, and which files an Improver may edit. Paths are relative to this directory, so use it as the harness working directory. Phoenix replaces `{task_file}` with the input task's path and can redirect model traffic with `MODEL_BASE_URL` or replace MCP entries in `.mcp.json` without changing the harness code.

The editable globs cover source, prompt, tool descriptions and model configuration, not the seed world, preferences, runtime state or the contract. Contract validation belongs to the Phoenix caller (`@phoenix/formats`); the harness itself does not import it. This example supplies no container image; a capture recipe or replay caller supplies the sandbox image, with Node 24, the MCP client and these files installed.
