# Pi 1.5.2

This recipe targets the installed `@earendil-works/pi-coding-agent` 1.5.2 and
session format v3. It runs `pi --mode rpc`; it does not install Pi, log in,
change providers, or copy credentials into a recipe. Check `pi --version` and
`pi auth check --provider <your-provider> --json` first. Stop if either is absent
or not ready. Never use the `--credentials` or credential-printing commands in
logs. Other Pi distributions and versions need their own verification.

## Live routes

Use an absolute path to `run.mjs` as the command inside `phoenix capture`.
The wrapper reads the launcher's selected routes from `capture.json`. The
launcher supplies the `phoenix` executable and command shims on PATH. A minimal
capture-only harness contract, stored outside the working tree if desired, is:

```yaml
phoenix_harness: 1
name: pi
run: {command: [pi, --mode, rpc], output: stdout}
endpoints:
  model: {env: PHOENIX_MODEL_BASE_URL, dialect: openai-responses}
editable: ["prompts/**"]
```

Choose the dialect of the selected provider, not a universal Pi dialect:
`anthropic-messages`, `openai-responses`, `openai-chat-completions`, or
`generate-content`. Pi's `openai-codex-responses` uses `openai-responses` on the
Phoenix side. MCP locations are in the descriptor's `configuration.mcp` rather
than the generic launcher's single-file `mcp` field. Do not put `mcp` in this
capture contract: the wrapper applies Pi's multi-file MCP overlay itself, so
the generic launcher must not wrap it a second time.
For Replay, the contract instead names the materialized MCP config as usual.

For an existing ChatGPT subscription, keeping the same upstream and model:

```sh
export PHOENIX_MODEL_BASE_URL=https://chatgpt.com/backend-api
phoenix capture --recipe /path/to/recipes/pi/recipe.yaml \
  --contract /private/path/pi.harness.yaml \
  --routes gateway,mcp-proxy,cli-proxy -- \
  node /path/to/recipes/pi/run.mjs --mode rpc \
    --provider openai-codex --model gpt-6.1-sol
```

The wrapper creates a private, retained agent-directory overlay. It changes
only the selected provider's `baseUrl` (including its model-level overrides),
and selects Pi's supported SSE transport. API names, model IDs, auth lookup,
provider headers and billing remain Pi's. An exact `--provider` and `--model`
are required for gateway capture. The original upstream must already have been
chosen by the person; the wrapper cannot infer it from a token. It does not
redirect auxiliary models, provider catalog/auth requests, or extension traffic.
Don't change models during such a capture without a matching route.

Pi reads the generated models through `PI_CODING_AGENT_DIR`. Existing files are
linked except copied `models.json`, `settings.json` and `mcp.json`; refreshed
credentials still go to Pi's original auth store through its link. Sessions stay
in the original session directory, unless `--session-dir` or
`PI_CODING_AGENT_SESSION_DIR` specifies another directory. Original model,
settings and MCP config bytes are never edited. Overlays can contain private
config and remain outside the capture in the system temporary directory. Remove
one only after keeping any new files you need.

For built-in MCP, each stdio entry in user `mcp.json` and trusted project
`.pi/mcp.json` becomes `phoenix mcp-proxy <name> -- <original argv>`. Other entry
fields, including env, cwd, exposure and enabled state, are retained. A project
MCP config needs a private symlink working-directory overlay; existing files
still point to their originals, but **new files remain in that retained
overlay**, as `coverage.jsonl` states. Relative paths use that working directory.
Project trust is still Pi's decision; pass `--approve` only for a project you
already trust.

`pi-mcp-adapter` replaces built-in MCP when installed. Pass its explicit
`--mcp-config /path/to/config.json`; the wrapper proxies that file into a private
copy. Expand adapter imports and disable other config discovery yourself first,
or those extra servers are transcript-only. Alternatively, an intentionally
isolated run can select Pi's native implementation with
`--no-extensions -e builtin:mcp`. This changes the extension loadout, so it is
not silently added by this recipe. Extension-registered tools have no universal
file override and are covered by the transcript.

Remote MCP URLs are left untouched, with a coverage limitation for each entry.
Pi supports them, but the shipped Phoenix launcher exposes only stdio MCP
proxying; its generic gateway is a model route, not an MCP HTTP route. In
particular, rewriting an OAuth resource URL would break Pi's token binding.
No local CA is installed, auth weakened, or unproved `HTTPS_PROXY` path enabled.
Use transcript capture for these servers; an existing stdio remote bridge can
be proxied as an ordinary stdio command without changing its authentication.

The recipe shims external `ls`, `cat`, and `date`. Customize `shim` for commands
the task actually uses. Pi's built-in file tools bypass PATH, as do shell
builtins and absolute executable paths. Bash may reset PATH through a user's
shell startup files: verify a shim event actually arrived instead of assuming
it did. CLI output does not recreate file writes.

## Login coverage

| Pi credential source or login | Model route |
| --- | --- |
| API key in env, `auth.json`, secret-command lookup, or `models.json` | Gateway when that provider honors `baseUrl`; transcript otherwise. No key is resolved by the wrapper. |
| Anthropic OAuth/bearer token, OpenAI Codex ChatGPT subscription | Same provider and token, gateway over the provider's HTTP/SSE API; transcript also available. Codex was proved on the existing login. |
| Copilot OAuth | Transcript. Pi's OAuth model modifier sets the token-selected endpoint after config. |
| Radius/custom Radius OAuth catalogs | Transcript. Gateway/catalog discovery and auth resource binding are not proved interchangeable. |
| Other OAuth providers, including xAI | Transcript unless their endpoint behavior is verified; the recipe does not refresh or export their tokens to test them. |
| Ambient Bedrock AWS credentials, Vertex ADC, Anthropic federation | Transcript. No claim that signed/cloud SDK transports accept this gateway or CA. |
| Extension providers (for example a local subscription CLI), arbitrary custom auth | Transcript unless the extension explicitly supports the chosen model route. |
| Unauthenticated local compatible endpoint | Gateway with that same endpoint and API; transcript available. |

All rows can use the configured stdio MCP and PATH routes independently of model
login. Remote MCP auth has the separate limitation above. An offered gateway
route is conditional, not permission to bypass a pinned provider. Omit `gateway`
when a row says transcript.

## RPC and after-the-fact capture

Send LF-delimited RPC records to stdin, read stdout continuously, and wait for
`agent_settled`, not just a successful `prompt` acknowledgement or `agent_end`.
Then close stdin and wait for orderly exit. A `get_state` response names
`sessionFile`. `--session-dir /private/path` makes a new proof log easy to find.
Don't use `--no-session` when a later import is required. One RPC process is
one Run; use explicit `phoenix task start/end` markers for multiple tasks.

For a run with **nothing in the live path**, run Pi normally, then:

```sh
phoenix import --recipe /path/to/recipes/pi/recipe.yaml /path/to/session.jsonl
# Source-checkout equivalent on Node 24:
node packages/cli/src/import.ts --recipe recipes/pi/recipe.yaml /path/to/session.jsonl
```

The launcher currently does not auto-run transcript readers. Import after Pi
exits, including after a live capture. `--capture <capture.json's capture id>`
and the same `--home` put that import beside live evidence; otherwise import
creates its own capture. Reimporting identical bytes is idempotent.

The reader consumes stdin, never reopens `PHOENIX_SOURCE`, and retains each raw
entry with its tree links, system sections, logged tool declarations, usage and
opaque signatures. Separate structured call/result events carry `tool_use_id`
for later reconciliation. Their connector is `pi-tools`, **not** an invented MCP
server identity or wire envelope. `verbatim` names source fields; it never
claims serialization or a synthesized timestamp was on the wire. Unknown
versions, records, roles, blocks and malformed rows produce `transcript.unread`
and make the import incomplete while retaining its valid prefix.

The transcript preserves all branches; it does not guess the active leaf or
reconstruct a model request from compaction/context edits. It lacks raw model
requests, wire tool lists/protocol versions, stream timing and unreported side
effects. Those need setup fills marked derived/synthesized, so transcript-only
evidence is not advertised as a byte-exact echo. Never commit a real session,
prompt, capture, credential, or proof bundle.

## Echo proof

Use the live tap evidence to create/approve a moment with the setup commands,
then run `phoenix replay echo --request /private/path/replay.json` (source:
`node packages/cli/src/replay.ts echo --request ...`). The sandbox image must
contain exactly the recorded Pi version and a small RPC driver which submits
the task, waits for `agent_settled`, and prints the final assistant text. Its
MCP config and model base URL must point to runner's shims, not real systems.
Credentials stay outside the image; use placeholders inside. Preserve the
original Pi config/system loadout, and report any prefix edits, missing fills,
or transcript limitations from `fidelity.json`, not merely the check verdict.

References: the installed Pi docs `models-configuration.md`, `providers.md`,
`mcp.md`, `rpc.md`, `session-format.md`, and `message-types.md`; upstream
[configuration](https://pi.dev/docs/latest/models-configuration),
[sessions](https://pi.dev/docs/latest/session-format), and
[MCP](https://pi.dev/docs/latest/mcp).
