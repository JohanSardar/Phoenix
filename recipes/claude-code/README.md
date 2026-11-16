# Claude Code

This recipe targets **2.1.325**, including its JSONL session format. It uses the
installed CLI and its existing login; it never installs, upgrades, signs in,
copies login state, sets a credential, or changes the selected provider.
`capture.mjs` checks installation/version and `claude auth status` before capture.
Core packages have no knowledge of this harness.

## Capture

Run from a trusted working directory. Pass the MCP config files you actually
want enabled, in precedence order; each must contain `mcpServers`. For example:

```sh
node /path/to/recipes/claude-code/capture.mjs \
  --login-mode subscription --upstream https://api.anthropic.com \
  --mcp "$PWD/.mcp.json" -- \
  -p 'List the scratch directory' --allowedTools 'Bash(ls *)'
```

The script starts a fresh session, keeps the original cwd and config directory,
and passes a private generated config through `--mcp-config` and
`--strict-mcp-config`. Other local/user/project MCP configs are intentionally
excluded: export their desired `mcpServers` entries into input files first.
No original file is edited. With no `--mcp`, no local MCP servers are enabled.
Plugin-provided and claude.ai/cloud connectors are outside that override and
must be assessed separately. The script does not claim to capture them.

The defaults are `gateway,mcp-proxy,cli-proxy,transcript`, except for the
fallback modes below, which omit `gateway`. `--routes transcript` puts nothing
in the live path. `--routes` can select any subset. `--shim ls,cat` names PATH
commands; an empty value disables shims. Shell builtins, absolute paths, shell
startup that resets PATH, and Claude's native file tools bypass those shims.
Native tool blocks still appear in session logs. CLI capture doesn't recreate
filesystem writes.

Every named stdio server runs behind `phoenix mcp-proxy`. A Streamable HTTP
server can use `--remote-reverse server-name` only when the person has established
that changing its resource URL is safe (for example, a fixed-header or anonymous
server). Its path, query, headers, bodies and protocol era are forwarded, without
discovery probes or added calls. **Do not use reverse capture for resource-bound
OAuth.** Leave that server direct and use its transcript tool blocks. SSE,
WebSocket, OAuth, and remote entries not explicitly authorized remain direct;
`recipe-coverage.json` names each fallback. Phoenix doesn't weaken authorization
or quietly start a second login. The generic gateway's optional
`PHOENIX_GATEWAY_SURFACE` and `PHOENIX_GATEWAY_CONNECTOR` identify these HTTP routes.

`--home` chooses the private Phoenix store; `--cwd` chooses the workspace.
`--claude` accepts a JSON argv array for an existing CLI wrapper. The default is
`["claude"]`; shell functions/aliases are not inherited by child processes.
Use an executable wrapper if it selects your account. Session/resume/config
overrides belong to this script; import existing/resumed sessions separately.

While the command dispatcher is being assembled, source checkouts can name the
two public CLI entrypoints explicitly (run this from the repository root):

```sh
node recipes/claude-code/capture.mjs --login-mode subscription \
  --upstream https://api.anthropic.com \
  --phoenix "[\"node\",\"$PWD/packages/cli/src/capture.ts\"]" \
  --importer "[\"node\",\"$PWD/packages/cli/src/import.ts\"]" \
  --mcp /absolute/path/to/mcp.json -- -p 'Perform a harmless scratch task'
```

## Login and model coverage

Select the mode that is **already active**. The script forwards credentials via
the unchanged child environment/credential store, not through generated files.
It never sets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a dummy credential
during live capture. In particular, setting only `ANTHROPIC_BASE_URL` preserves
a subscription login; supplying a gateway key instead would change billing.
For every gateway mode, name the **existing** upstream with `--upstream` or its
base-URL environment variable. Settings-file endpoints aren't guessed; an
explicit endpoint prevents silently replacing a configured company gateway.

| Mode | Model route and limits |
| --- | --- |
| `api-key` | `ANTHROPIC_API_KEY` or an already approved/saved key; `ANTHROPIC_BASE_URL` gateway. |
| `console` | Existing Console browser/organization login, including keyless Console OAuth; same base-URL route. |
| `subscription` | Existing claude.ai Pro/Max/Ultra/Team/Enterprise OAuth; same base-URL route, forwarding Authorization and OAuth beta headers unchanged. |
| `oauth-token` | Existing `CLAUDE_CODE_OAUTH_TOKEN` from setup-token; same route. |
| `auth-token` | Existing bearer gateway credential; preserve the existing upstream via `--upstream` or the base-URL environment variable. |
| `api-key-helper` | Existing `apiKeyHelper`; don't copy its output. Same route. |
| `profile-wif` | Existing Anthropic profile/workload-identity federation; same inference route. Token exchange and refresh aren't captured. |
| `bedrock`, `aws` | AWS signed credentials (keys, profile, SSO, credential process, role/web identity). Changing the signed host breaks SigV4, so model capture is transcript-only. |
| `bedrock-bearer` | Existing Bedrock bearer/API-key mode; `ANTHROPIC_BEDROCK_BASE_URL`, explicit existing `--upstream` required unless exported. |
| `aws-bearer` | Existing Claude Platform on AWS bearer mode; `ANTHROPIC_AWS_BASE_URL`, explicit existing upstream required unless exported. |
| `vertex` | Existing ADC/service-account/workload identity; `ANTHROPIC_VERTEX_BASE_URL`, explicit existing upstream required unless exported. |
| `foundry` | Existing API key or Entra/managed identity; `ANTHROPIC_FOUNDRY_BASE_URL`, explicit existing upstream required unless exported. |
| `claude-apps-gateway` | Existing corporate SSO gateway session chooses its resource-bound endpoint; transcript-only for the model. |
| `managed` | Endpoint/provider restrictions or settings pin the destination. Don't override policy; transcript-only for the model. |

The gateway records HTTP regardless of dialect. Bedrock/Vertex/Foundry native
payloads are **not** claimed to be replayable as the `messages` dialect; setup
must assess their actual evidence. MCP/CLI/transcripts remain available in all
modes, subject to managed MCP policy. If an install ignores or refuses a base-URL
override, omit the gateway route and import the transcript; do not change login,
unset its provider flags, or substitute a key. The shipped launcher has no
trusted TLS forward-proxy configuration, so it does not advertise that fallback.

Only the subscription path has been exercised with a real account here. Other
mode mappings follow the vendor documentation; they are not claims of live
credential validation across providers.

## After the fact

Session logs live under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, or
the corresponding `CLAUDE_CONFIG_DIR`. Normal capture imports that new session
after the launcher closes. Import a pre-existing log with **no live capture**:

```sh
node packages/cli/src/import.ts --recipe recipes/claude-code/recipe.yaml \
  --home /private/phoenix /path/to/session.jsonl
```

The reader consumes stdin, never reopens `PHOENIX_SOURCE`. It retains source
records and messages as metadata, and emits tool-use/result blocks with their
original IDs, inputs and content. Native tool names stay distinct from CLI
invocations. The `mcp__server__tool` naming convention supplies connector/operation
labels, which aren't marked verbatim. It does **not** invent JSON-RPC envelopes,
HTTP requests, tool lists, system prompts, CLI exit codes or timings. Unknown
versions, record types, malformed rows, orphan tool results and unsupported
content blocks produce `transcript.unread`; valid earlier evidence survives and
the import is incomplete. Imports use the core's shared secret stripping and
immutable deduplication. No real session data belongs in this recipe or in git.
Rows without a source timestamp use the reader's observation time, never marked
verbatim. The session ID is metadata, not a server-task marker: importing a
single CLI session must not orphan the launch's untasked live evidence.

The raw-record metadata deliberately overlaps the live taps. Setup must select
one evidence route for each exchange; it must not count the same action twice.
Transcript-only runs need explicit derived/synthesized fills before wire replay.

## Replay

Build `Dockerfile` on top of the sandbox image from `packages/sandbox/images`,
then pin its digest in a runner request. The Linux CLI is installed in the image;
no host login state enters it. A replay harness contract must name its command,
model endpoint, MCP config, output and editable paths. Supply placeholder
credentials only in the container, and keep real credentials on the engine host.
Run `node packages/cli/src/replay.ts echo --request request.json` before trying
later start points. Session IDs, dynamic prompts, cwd, native tools, CLI platform
differences and model configuration can drift; the runner's fidelity report is
the authority, not a blanket promise that an unchanged binary can echo perfectly.

Observed on the existing subscription: a harmless real run captured `ls -1`,
one stdio MCP call and one explicitly authorized HTTP MCP call. All three live
surfaces recorded, and transcript import completed with 49 reader events.
After-only import and immutable reimport also completed. The first container echo
replayed MCP discovery, then stopped with `prefix-drift` at
`history/0/content/0/text`: signed in with a Claude account, the CLI adds a
block with the account email to the first user turn, and the placeholder-key
container doesn't. `recipe.yaml` declares that block as `model.login_context`
(`account-email`); copy its `name` and `pattern` into the request's
`loginContext`. With it, the same capture echoes in the container with
`meets-check` and a **recorded** grade, the fidelity report lists the missing
block under `prefix_uncompared`, and a replay from the second model request
also meets the check. The system-role environment turn, cache TTLs and
`metadata` differ too and are reported as `prefix_edits`. An edited tool
result still stops with `prefix-drift`. Keep
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` as it was at capture: the captured
`HEAD /api/hello` connectivity check is part of the prefix. Never copy login
state into the container.

The tested native CLI also needed a fresh libfaketime shared-memory handle when
started from Node: delete `FAKETIME_SHARED` from the child's environment while
keeping `LD_PRELOAD` and the clock file. Otherwise that image failed at startup
with `sem_open ... File exists`. The runner's Node clock probe saw virtual time;
the native runtime's clock remains unverified.

Sources: [authentication](https://code.claude.com/docs/en/authentication),
[gateway](https://code.claude.com/docs/en/llm-gateway),
[provider endpoints](https://code.claude.com/docs/en/llm-gateway-connect),
[MCP configuration](https://code.claude.com/docs/en/mcp), and
[session storage](https://code.claude.com/docs/en/how-claude-code-works).
