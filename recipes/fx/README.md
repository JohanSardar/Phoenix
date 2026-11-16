# fx 0.0.16

This recipe covers the native `vercel-labs/fx` ACP agent, not the JSON viewer of the same name. Check `fx --version` and `fx status --json` first. It never installs fx, logs in, changes the selected provider, or edits the original settings/MCP files. Later fx versions need a separate compatibility check.

## After the fact: no live proxy

Import a closed native session log directly:

```sh
node packages/cli/src/import.ts --recipe recipes/fx/recipe.yaml \
  --home /private/phoenix ~/.fx/sessions/v2/SESSION_ID/log.jsonl
```

The reader consumes only stdin. It checks the v1 log's sequence and CRC32C, preserves native wall times, imports known records, and reports unknown kinds, versions, truncated tails and unclosed sessions as unread. It preserves valid records before a torn UTF-8 tail. It does not reopen result-store artifacts beside the source. A native result's preview and artifact reference are not its complete output, even when fx says the stored artifact is complete. Use the read-only session export to obtain result text that fx can still load:

```sh
umask 077
node recipes/fx/export-session.mjs SESSION_ID > /private/session.json
node packages/cli/src/import.ts --recipe recipes/fx/recipe.yaml \
  --home /private/phoenix /private/session.json
```

This stamps the installed fx version on `fx session --id ID --json` output. The supported presentation execution schema is 3. Exported calls have only session-level wall time; that time is not marked verbatim for individual calls. An interrupted turn is reported as unread, and truncated outputs are partial. Every event has `verbatim`. Tool identities and argument/output values are preserved without inventing JSON-RPC envelopes, inferring connector names from underscores, or pretending these are model wire exchanges. Import subagent sessions separately. Neither route needs anything in the live path; `--no-save` leaves no session to import.

These imports create separate captures by default. Before importing into an existing live capture, its task markers must already use the native session ID; otherwise previously unkeyed wire events become unattributed. The reader does not invent that association.

## Live ACP, MCP and CLI

`capture.mjs` calls the public Phoenix capture command. Its JSON-format copy of the descriptor/contract delegates MCP configuration to `acp.mjs`, rather than the generic project's stdio-only overlay. The working directory stays unchanged. The helper requires a JSON harness contract (JSON is valid YAML), for example:

```json
{
  "phoenix_harness": 1,
  "name": "fx",
  "run": {"command": ["fx", "acp"]},
  "endpoints": {"model": {"env": "PHOENIX_FX_MODEL_URL", "dialect": "responses"}},
  "editable": ["prompts/**"]
}
```

Use an absolute recipe-script path when the workspace is elsewhere. For this source checkout, set `PHOENIX_COMMAND` to the JSON argv `['node', '/absolute/phoenix/packages/cli/src/capture.ts']` using **double quotes**, not shell quotes, inside the JSON. An installed Phoenix uses the default `["phoenix"]`.

```sh
node recipes/fx/capture.mjs --cwd /scratch/workspace \
  --routes mcp-proxy,cli-proxy -- \
  node /absolute/phoenix/recipes/fx/acp.mjs \
  --mcp-config /scratch/workspace/.mcp.json
```

Connect an ACP client to that command. `acp.mjs` rewrites stdio entries in the client's `session/new`, `session/load` and `session/resume` `mcpServers` arrays to `phoenix mcp-proxy`; it also reads the explicitly named fx `mcpServers` config. Client entries win name collisions. A client requesting `_meta.fx.profileMcpServers` gets its profile's stdio servers wrapped, while fx still loads the native profile for other servers. The six routing variables are passed explicitly because fx filters inherited MCP subprocess variables. Project servers not explicitly supplied still follow fx's normal project trust/configuration; they are not claimed as captured. Passing `--mcp-config` is an explicit admission of those entries, not an automatic approval of arbitrary projects.

`PHOENIX_FX_HTTP_STDIO=1` opts explicitly supplied Streamable HTTP servers with **no authentication or static headers/tokens** into the HTTP-to-stdio bridge and MCP proxy. Configure headers and `bearer_token_env` in the fx config; values stay in the child environment, never command arguments. The bridge supports JSON/SSE responses, negotiated legacy session headers, concurrent calls, server notifications on GET, and session DELETE. It records the JSON-RPC bytes delivered to fx after transport translation, not original HTTP headers or SSE timing. It never follows redirects with credentials. Do not use it for a remote OAuth server: leave that server on its original native fx configuration so the existing login authority is preserved, and use the transcript fallback. Legacy SSE servers are unsupported by this fx release itself. Do not opt an OAuth profile into a different endpoint or credential scope.

The selected CLI route adds `ls`, `cat` and `date` through PATH. Absolute commands, shell builtins, a shell startup that replaces PATH, and fx's fixed-path read-only command optimization bypass it. Native filesystem tools and direct/provider-native APIs also need the transcript fallback. A bare `ls` can use that optimization; a real shell invocation that retains PATH can reach the shim. CLI recording captures output/exit, not filesystem side effects. Inspect actual segments, not just configured routes.

## Model routes by login mode

| Existing login | Model route | Setting and limits |
| --- | --- | --- |
| Gateway API key (environment or Keychain), Vercel OAuth, Vercel OIDC | Gateway + transcript | `FX_GATEWAY_CHAT_URL` accepts a loopback HTTP URL. The unchanged fx auth flow supplies the credential. Protocol is Vercel AI SDK v4, not OpenAI wire. |
| Codex/ChatGPT subscription | Transcript | The release has no supported model endpoint override. Test-only `FX_E2E_*` switches are not a supported capture route. No TLS interception or provider switch is attempted. |
| Grok subscription | Transcript | Same pinned-endpoint restriction and fallback. |
| Named custom bearer-env or no-auth connection | Gateway + transcript | `providers.NAME.base_url`; this fx release accepts only `openai-chat-completions` for configured connections. |

For Gateway, set `PHOENIX_FX_MODEL_URL=https://ai-gateway.vercel.sh`, `PHOENIX_FX_MODE=gateway` and add `gateway` to `--routes`. The capture command replaces that environment variable with its loopback URL; `route-model.mjs` adds `/v4/ai/language-model` for fx. This records that model endpoint, not every auxiliary catalog, search or OAuth request. Phoenix currently has no Vercel AI SDK model-wire decoder, so recording this transport does not provide a supported frozen-prefix model Replay.

For custom connections, set `PHOENIX_FX_MODEL_URL` to the **exact original API prefix**, `PHOENIX_FX_MODE=custom`, and `PHOENIX_FX_CONNECTION` to the already selected top-level connection name. The helper copies settings into a private temporary HOME and changes only that connection's base URL. It does not copy credentials/session files or select another provider; bearer values remain existing environment variables. Set the harness contract's dialect accordingly. Temporary HOME changes fx/tool home context and excludes the original profile's implicit MCP/skills/history, so explicitly supply the wanted MCP config, avoid workspace provider overrides, and include this difference in fidelity assessment. The temporary profile is removed on normal close. Use the transcript route if changing HOME is unacceptable. Abrupt host death can leave the private temporary settings copy for manual cleanup.

Only the installed Codex subscription was available for real provider proof; the other login routes are declared from the matching release source and can be exercised against local protocol endpoints without spending another account's credits.

## Replay and fidelity

Build `Dockerfile` on top of a prepared Phoenix sandbox image and resolve the resulting image to its digest before giving it to runner. It includes the checksum-verified Linux fx release, not the Mac binary, credentials, sessions or a model account. `recipe.yaml`'s image name is a build target, not a mutable image passed to runner.

Wire MCP/CLI evidence can replay those connectors. The current generic runner rewrites only `mcpServers` JSON configurations, so use that explicit config format when recording a run intended for echo. Live capture also accepts fx's canonical `mcp` command arrays, but the runner cannot directly rewrite that native format; it reports a setup failure rather than silently changing the evidence.

Session evidence alone cannot supply missing provider requests, a complete system prompt, tool definitions, MCP envelopes or CLI frame bytes. Setup must explicitly derive/fill missing evidence, with its provenance. A pinned-subscription capture without model wire is **not a full frozen-prefix echo**; runner must report drift or incompleteness rather than a fabricated passing echo. Keep its fidelity report with the coverage report. Static fx clock coverage is real/unknown even when the Node probe is virtual; the recipe does not claim full clock virtualization.

References: [fx v0.0.16 source](https://github.com/vercel-labs/fx/tree/v0.0.16), especially `src/builtins/gateway.zig`, `src/core/shared/profile_paths.zig`, `src/acp/sessions.zig`, `src/core/session_manager/schema.zig` and `src/core/output/output_contracts.zig`. Current online docs can describe newer fx releases; this recipe's version boundary is intentional.
