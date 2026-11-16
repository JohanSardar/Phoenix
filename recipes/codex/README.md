# Codex

This recipe supports Codex CLI 0.169.0. It reads `$CODEX_HOME/config.toml`
(default `~/.codex/config.toml`) and imports new JSONL files under
`$CODEX_HOME/sessions`. It never edits that config, logs in, changes the selected
model/provider, or copies credentials into Phoenix config. Node 24+, Python
3.11+ (`tomllib`) and the repository's installed dependencies are required.

Use the recipe launcher, not the generic JSON-MCP launcher:

```sh
node recipes/codex/capture.ts --login-mode chatgpt --cwd /path/to/task \
  --routes mcp-proxy,cli-proxy,transcript -- exec --skip-git-repo-check 'List the files'
```

Routes are explicit. For an **already selected custom provider**, add `gateway`
to capture model HTTP requests and streamed Responses responses. The launcher
points that provider's `base_url` at the gateway and disables its WebSocket
transport for this launch. All other provider fields, headers, environment-key
references and credential helpers remain Codex's own. Built-in OpenAI still
attempts WebSockets in this version despite its feature overrides, so this HTTP
gateway refuses it: use transcripts without changing providers. Name the actual
login mode; the launcher never switches between subscription and API billing.
If HTTP/SSE or endpoint overrides are disallowed, omit `gateway` and use
`transcript`. No TLS interception is attempted.

## Put Codex back in a moment

Codex saves every session as a file under `~/.codex/sessions/YYYY/MM/DD/`.
Phoenix can cut that file at a moment and let Codex go on from there in the box,
with a changed harness. Copy the session file first. Phoenix only reads it.

```sh
phoenix moment create --session rollout-....jsonl --recipe recipes/codex/recipe.yaml \
  --at <line> --id <id> --check check.yaml <out-dir>
```

`--at` is a line of the session file. The moment starts at the user turn that
holds that line. Codex gets everything before that turn and then the turn's
message again. Sessions from Codex 0.167.0 and 0.169.0 that used a ChatGPT login
are supported.

In checks, MCP tools are named `<server>.<tool>`, for example
`github.create_issue`. Shell commands are `codex-shell.exec`.

### What happens in a replay

The box runs Codex's own `codex exec fork` on the cut session. Codex keeps the
history and starts a new session from it. Codex talks to its LLM directly at
chatgpt.com. Nothing from Phoenix sits in between.

Phoenix answers the tool calls from the session's own results:

- Each MCP server of the session is replaced by `mcp-stand-in.mjs`. It offers
  the server's tools with the descriptions the session saved, and sends every
  call to Phoenix.
- Codex runs shell commands with `zsh -lc`. In the box, `zsh`, `bash` and,
  for Codex only, `sh` are `shell.mjs`, which sends the command to Phoenix
  instead of running it.

### The harness

- `AGENTS.md`: instructions, added after the session's own global
  `AGENTS.md`.
- `config.toml`: Codex settings, laid on top as a Codex profile
  (`codex exec -p`). `model` swaps the LLM. `[features] shell_tool = false`
  takes the shell away. `disabled_tools` under `[mcp_servers."<server>"]` hides
  MCP tools.
- `models.json`: Codex's LLM list (`model_catalog_json`), when the session's
  LLM needs one.

List the files you want an agent to change under `editable` in
`phoenix.harness.yaml`.

### Login

`login.mjs` copies Codex's ChatGPT login into the box for one run, without its
refresh token. It is deleted after the run and never goes into a bundle, trace
or git. The login must be valid for 15 more minutes; run `codex` once to
refresh it.

### Build the box image

```sh
docker build -f recipes/codex/resume.Dockerfile -t phoenix-codex-resume:0.169.0 recipes/codex
```

Put the image ID and the path to `recipe.yaml` in the Workbench settings.

### Limits

- A tool call the session never made gets no answer, and the replay stops
  there. Codex often runs a new shell command first, like `pwd`, so many
  replays stop early. Ticket T11 (JOH-55) owns the fix, for every harness.
- The box runs Codex 0.169.0. Its own tool descriptions and base instructions
  can differ from the ones in an older session.
- Other sites on chatgpt.com can be reached from the box.
- A user turn with images or files can't be a moment yet.
- The resumed run uses the real clock.

## Login coverage

| Mode | Live model capture | Fallback |
| --- | --- | --- |
| `api-key` | Not offered for built-in OpenAI: its WebSocket transport bypasses this HTTP tap | Session reader; Codex retains its stored/environment API key |
| `chatgpt` | Not offered for built-in OpenAI; browser OAuth and device-code sign-in use the same session mode | Session reader with the existing ChatGPT login |
| `chatgpt-custom-provider` | Already selected custom provider URL, preserving its ChatGPT-auth configuration and backend | Session reader if endpoint overrides are disallowed |
| `custom-api-key` | Active `model_providers` base URL; `env_key`, bearer-token or header config unchanged | Session reader |
| `custom-oauth` | Active custom provider URL; its own browser OAuth/token store remains in use | Session reader when the OAuth audience/endpoint cannot be reverse-routed |
| `command-auth` | Active provider URL; its `auth.command` still obtains credentials | Session reader |
| `local` | A custom OpenAI-compatible local provider with explicit URL needs no Codex login | Session reader for built-in Ollama/LM Studio selection without an explicit custom URL |
| `bedrock` / `vertex` | Not offered: native signing and cloud credential paths aren't an ordinary Responses reverse route | Session reader; no replacement provider or API-key login |

MCP and PATH capture are independent of model login. A failed explicitly chosen
route fails loudly; it is never silently replaced. The table describes route
availability, not a claim that every account mode was exercised. The real proof
used the Mac's existing ChatGPT login and selected custom provider. Profiles,
CLI config/profile overrides (including attached `-c`/`-p`), `--oss`,
`--ignore-user-config` and `--ephemeral` are refused by this fresh-`exec`
launcher. Codex `-C`/`--cd` and `--worktree` are also refused: set the recipe's
`--cwd` so Codex and the snapshot use one canonical task directory. A
`.codex/config.toml` between the Git project root and that directory makes routing
ambiguous, so live model/MCP routes are refused; transcript-only capture and
normal Codex invocation followed by explicit import remain available. Managed
restrictions are never bypassed.

## MCP and commands

Each enabled stdio entry in `mcp_servers` is overridden with the Phoenix proxy
command and original command/argv. Its original environment, cwd, timeouts,
enabled/disabled tools and other policy settings stay in place. The recording
environment is passed explicitly because Codex filters stdio-server variables.
An explicitly configured server PATH is preserved exactly; commands inside that
server bypass the generic CLI shims rather than resolve to a different executable.
There is no extra discovery request or tool added by the recipe.

Remote HTTP servers remain at their original URLs by default. Add
`--reverse-mcp server1,server2` **only** for servers whose authorization remains
valid behind a loopback reverse route (for example, your unauthenticated local
server or a server explicitly configured to allow that route). The script starts
the generic `mcp-http-proxy` runtime and overrides only the URL, preserving its
query. Existing bearer/header settings stay Codex's own. Don't use this opt-in
for resource-bound OAuth: stored OAuth credentials may be indexed by the original
URL, and authorization discovery may change. `auth = "chatgpt"` is refused.
These servers fall back to their logged tool items; no CA or auth policy is
weakened. Plugin/dynamic servers aren't rewritten.

The descriptor's `shim` list defaults to `ls`; edit that list for the external
commands you need. The generic launcher adds their proxies to PATH. Absolute
paths, builtins, shell startup files that reset PATH, and Codex's internal tools
bypass these proxies. Shell tools must preserve the inherited PATH (for example,
`exec_command` with `login: false`). A CLI result is not a filesystem snapshot of
its side effects. Direct HTTP calls aren't intercepted by this recipe.

## After-the-fact capture

Nothing has to be in the live path:

```sh
node packages/cli/src/import.ts --recipe recipes/codex/recipe.yaml \
  --home /private/phoenix /path/to/rollout.jsonl
```

Or launch with `--routes transcript` to snapshot the task directory and import
only newly created session files after exit, with no tool/model proxy. Resumed
files, paginated history, disabled session logging and ephemeral runs may not
produce a new JSONL file; the launcher records a gap and exits nonzero. Import
an explicitly selected file yourself rather than sweeping someone's old logs.

The reader consumes stdin, not `PHOENIX_SOURCE`. It keeps logged response items,
call IDs, function/custom-tool inputs and outputs, base instructions, turn
context and wall times. Completed command/MCP items expose their logged
argv/exit code or server/tool/arguments/results as semantic call/result events;
the raw model-visible wrapper remains separate and isn't guessed into a wire
request. Other event-log duplicates remain metadata. It does **not** invent model
HTTP exchanges, MCP envelopes, protocol versions, raw streams, terminal controls,
timings or missing reasoning. Reconstructed
answers belong to setup and must be tagged derived/synthesized. Unknown record
types or versions are retained as payload-free unread markers; import stays
incomplete. `verbatim` names only fields supplied by the session. The importer
strips secrets and makes retries idempotent. The launcher tags its fresh exec
and imports only a new file with that tag, so concurrent unrelated sessions
aren't swept into the capture. Its `--single-run` reader argv associates those
items with the one live Run; explicit imports retain the logged session ID.

## Replay and clock

Use the imported trace together with any live tap evidence to set up a Moment,
approve its check, and run `packages/cli/src/replay.ts echo` before trying a later
start point. Session-only evidence cannot prove wire-level equivalence: fills
and uncompared fields must remain visible in the fidelity report. Do not turn
logged items into invented HTTP requests to make echo pass.
Streams that end before transport EOF remain partial even when an SSE
`response.completed` event was observed; those responses cannot back an echo.
The real proof captured model traffic, MCP and PATH calls and imported the
session, but its echo was blocked by missing complete model responses and a
model-catalog request prefix mismatch. It is not a successful equivalence proof.

The recipe doesn't ship a vendor binary or credentials. Build a sandbox image
with the matching Linux Codex version and the Phoenix relay, pin its image
digest, and configure its harness entrypoint to read the runner's endpoint
environment. The optional `replay.ts` bridge is such an entrypoint: copy it into
the base harness tree; use `[node, replay.ts, "{task_file}"]` as its command,
`PHOENIX_CODEX_MODEL_URL`/`openai-responses` as the model endpoint, and
`.phoenix-mcp.json`/`mcpServers` as its MCP endpoint. That JSON file names the
captured servers so the runner can substitute its relays. Set nonsecret
`CODEX_MODEL` and optionally `CODEX_REASONING_EFFORT` in the Replay request.
The bridge creates a private temporary Codex home with placeholder auth, never
uses a host credential, and bypasses Codex's inner sandbox only inside Phoenix's
already isolated workload. Match any further captured config yourself; a
different OS, cwd or system context can produce an honest echo prefix drift,
which means later starts aren't supported by that base.

Copy `clock-probe.ts` into that tree and set `clock.probe` to
`[node, clock-probe.ts]`. It starts native Codex in a private temporary home with
placeholder auth and an unreachable loopback model URL, prints the first native
session timestamp, then terminates and cleans up. No real model call or login
is needed. The default static Linux musl binary ignores libfaketime in the
exercised image, so its observed clock mode is real. Clock coverage is
informational and does not lower fidelity.

Config references: [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
