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

Routes are explicit. Add `gateway` to capture model HTTP requests and streamed
Responses responses. The launcher points only the **currently selected**
provider's `base_url` (or built-in `openai_base_url`) at the gateway and disables
that provider's WebSocket transport for this launch. All other provider fields,
headers, environment-key references and credential helpers remain Codex's own.
For built-in OpenAI, the upstream is its configured URL or `OPENAI_BASE_URL`,
otherwise the API endpoint for `api-key` or the ChatGPT backend for `chatgpt`.
Name the actual login mode; the launcher does not infer it or silently switch
between subscription and API billing. A custom OpenAI-compatible provider keeps
its configured URL. If HTTP/SSE or endpoint overrides are disallowed, omit
`gateway` and use `transcript`. No TLS interception is attempted.

## Login coverage

| Mode | Live model capture | Fallback |
| --- | --- | --- |
| `api-key` | Built-in OpenAI base-URL override; Codex retains its stored/environment API key | Session reader |
| `chatgpt` | The same built-in override, preserving ChatGPT auth and its backend; browser OAuth and device-code sign-in are the same session mode | Session reader if managed settings pin the URL or transport |
| `custom-api-key` | Active `model_providers` base URL; `env_key`, bearer-token or header config unchanged | Session reader |
| `custom-oauth` | Active custom provider URL; its own browser OAuth/token store remains in use | Session reader when the OAuth audience/endpoint cannot be reverse-routed |
| `command-auth` | Active provider URL; its `auth.command` still obtains credentials | Session reader |
| `local` | A custom OpenAI-compatible local provider with explicit URL needs no Codex login | Session reader for built-in Ollama/LM Studio selection without an explicit custom URL |
| `bedrock` / `vertex` | Not offered: native signing and cloud credential paths aren't an ordinary Responses reverse route | Session reader; no replacement provider or API-key login |

MCP and PATH capture are independent of model login. A failed explicitly chosen
route fails loudly; it is never silently replaced. The table describes route
availability, not a claim that every account mode was exercised. The real proof
used the Mac's existing login and selected provider. Managed profiles, CLI
config/profile overrides, `--oss`, `--ignore-user-config` and `--ephemeral` are
refused by this fresh-`exec` launcher: prepare the desired unprofiled config first. Normal
Codex invocation followed by explicit import remains available for these cases.

## MCP and commands

Each enabled stdio entry in `mcp_servers` is overridden with the Phoenix proxy
command and original command/argv. Its original environment, cwd, timeouts,
enabled/disabled tools and other policy settings stay in place. The recording
environment is passed explicitly because Codex filters stdio-server variables.
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

The default Linux musl binary may ignore libfaketime. `codex
--version` is a presence/version probe, not evidence of a fake-clock timestamp;
report that process as real-clock/unknown when it cannot be probed. Clock
coverage is informational and does not lower fidelity.

Config references: [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
