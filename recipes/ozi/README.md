# Ozi

This recipe reads Ozi's own provider logs and can launch a fresh capture-only Ozi home with native provider routing. It targets the installed 0.1.0 app and the 0.1.4 checkout configuration. Check `ozi --version` first. It never installs Ozi, logs in, changes billing, or edits the existing home. A running server cannot acquire new routing settings retroactively.

## After the fact: nothing in the live path

Ozi stores state in `$OZI_HOME/userdata` (normally `~/.ozi/userdata`; a checkout can use `.ozi/userdata`). Its database is `statev2.sqlite`, not a Claude or Codex session directory. Import the selected thread's own `logs/provider/events.<thread-id>.log` file, including retained rotations oldest first:

```sh
node packages/cli/src/import.ts --recipe recipes/ozi/recipe.yaml \
  --home "$PHOENIX_HOME" "$OZI_HOME/userdata/logs/provider/events.$THREAD_ID.log"
```

The reader consumes stdin exactly once; `PHOENIX_SOURCE` supplies only the filename's thread identity. It accepts Ozi's `[ISO timestamp] NTIVE|CANON|ORCH: JSON` records, retaining their JSON text as metadata rather than inventing HTTP, CLI, or MCP wire exchanges. Known native protocols include Claude SDK, Codex app-server, ACP, Pi RPC, Muse MSP, Cursor SDK and OpenCode SSE. Unknown framing/protocols, malformed bytes, and bounded summaries are reported unread. Logs have no Ozi-version header, so the framing and protocol are checked, not a fabricated version field.

Coverage lists messages and any tool arguments/results the log actually kept. It explicitly lacks model HTTP bodies, complete MCP exchanges/tool schemas, CLI byte streams/status, filtered deltas, deleted rotations, complete prompts/history, monotonic timings, and filesystem snapshots. A complete import means the available log parsed; it does **not** mean complete capture or a successful echo. A log-only Moment normally needs setup fills or a fresh in-path recording before an exact Replay is possible. Raw provider records remain metadata so the engine cannot mistake an SDK message for a model API response.

## Native live routes

The launcher composes with Phoenix's existing capture command. Give the capture working directory a harness contract whose model endpoint is `{env: PHOENIX_MODEL_BASE_URL, dialect: anthropic-messages}` for Claude, or `openai-responses` for API-key Codex. Its MCP endpoint is `{file: .mcp.json, format: mcpServers}`. `.mcp.json` contains only the selected external stdio servers; Phoenix makes the proxied private copy. The recipe shims `ls`, `cat`, and `date`; copy the descriptor to change that list.

For native Claude, with the normal login already available and `OZI_CAPTURE_HOME` naming a nonexistent directory whose parent exists:

```sh
export PHOENIX_MODEL_BASE_URL=https://api.anthropic.com
node packages/cli/src/capture.ts capture --recipe recipes/ozi/recipe.yaml \
  --cwd "$TASK_DIRECTORY" --routes gateway,mcp-proxy,cli-proxy -- \
  node "$PWD/recipes/ozi/launch.mjs" --source-home "$OZI_HOME" \
  --home "$OZI_CAPTURE_HOME" --instance claudeAgent --driver claudeAgent \
  --model-env ANTHROPIC_BASE_URL --mcp-file .mcp.json -- \
  ozi serve --no-browser --mode desktop --host 127.0.0.1 --port 3775
```

Use the actual upstream base URL already selected by the person, not a different provider. Omit `gateway` and `--model-env` together for a pinned endpoint. Omit `mcp-proxy` and `--mcp-file` together when there are no external stdio servers. Use an absolute script path when invoking this outside the repository root. The isolated Ozi home is retained for transcript import; it copies settings, not databases, logs, or auth files from the native home. Ozi-owned managed credentials and redacted settings backed by its secret store cannot be moved by this launcher: it refuses those instances, which use the existing home's transcript route instead.

`launch.mjs` writes the selected instance's environment, including the capture PATH, through `userdata/settings.json`. This matters because Ozi normally puts login-shell PATH entries before its inherited launch PATH. It translates the proxied `.mcp.json` into Claude's `config.launchArgs --mcp-config` or native Codex's `-c 'mcp_servers={"name"={...}}'` overlay, preserving its effective `OZI_CODEX_LAUNCH_ARGS` or configured launch arguments. For native API-key Codex use an explicitly configured `setupMode: existing` instance, `--driver codex`, its instance ID, `--model-env OPENAI_BASE_URL`, and the person's existing API base URL. No key is inserted or substituted. Native `homePath` and `shadowHomePath` settings are preserved.

**The injected `t3-code` server is different.** Ozi constructs its authenticated loopback `/mcp` endpoint at runtime and overrides that entry in Claude/Codex/Pi; there is no user MCP URL setting for it. This recipe refuses an external entry named `t3-code`. Its calls use transcript fallback. External HTTP/OAuth MCP also uses transcript fallback with the current generic launcher, which only overlays stdio entries. No unverified forward proxy, CA installation, or undocumented endpoint override is advertised. CLI absolute paths, shell builtins, and tools that reset PATH bypass shims. Direct vendor HTTP is not captured by these routes.

## Login-mode coverage

Every mode retains the transcript route. `gateway` in the descriptor is an offered route only when that mode's effective native endpoint can be redirected; it does not assert that a tenant policy permits it. The native login and credentials stay native.

| Ozi driver and login | Model route | MCP and CLI routes |
| --- | --- | --- |
| Claude API key, subscription, Console, SSO | `ANTHROPIC_BASE_URL` in instance environment; transcript if policy pins it | External stdio via `launchArgs --mcp-config`; PATH shims; injected/HTTP MCP via transcript |
| Claude Bedrock | Transcript; no proven Bedrock endpoint/CA override | Same native external stdio and PATH routes |
| Codex existing-mode API key | `OPENAI_BASE_URL` in instance environment, Responses dialect | External stdio through `launchArgs`/`OZI_CODEX_LAUNCH_ARGS`; PATH shims |
| Codex existing-mode ChatGPT browser, device, access token, Bedrock | Transcript; API-key base URL is not a subscription override | Native external stdio and PATH routes; injected MCP via transcript |
| Codex managed ChatGPT browser/reconnect profiles | Transcript; Ozi's managed runtime fixes the base URL and replaces launch arguments | Existing managed home's transcripts; CLI requires a PATH override on that running instance, not a new empty home |
| Pi | Native `/login`, API keys, and provider/bridge-specific methods retain their own labels | Transcript; native `PI_CODING_AGENT_DIR`/`models.json` are not a universal Ozi model setting |
| fx | Native `fx login`, shared between instances | Transcript; no demonstrated Ozi model override |
| Muse | Native `muse login` or explicitly configured `META_API_KEY` | Transcript; inherited `META_API_KEY` is removed by Ozi, so do not change login by adding one |
| Grok | Cached account token or `xai.api_key`/`XAI_API_KEY` | Transcript; no demonstrated model base-URL override |
| Cursor | Browser login or explicit `CURSOR_API_KEY` | Transcript; `apiEndpoint` is a usage endpoint, not a proven model route |
| Antigravity | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` | Transcript; preserve API key, project/location, and chosen account mode |
| OpenCode | All native connected-provider logins | Transcript; `serverUrl`/`serverPassword` configure its control server, not the model endpoint |
| ACP registry/local command | Discovered agent, terminal, credentials, or arbitrary `authMethodId` | Transcript; preserve the advertised method instead of guessing an auth mode |

All drivers can inherit a selected instance's capture PATH where their subprocesses honor it. The descriptor does not claim native API/HTTP/MCP evidence from those fallback modes. Provider-specific native recipes can be composed after their actual configuration is validated; this recipe does not silently switch to one.

## One thread per Run

Use the actual Ozi thread ID, not the long-lived server PID. Start and end a task marker around a command that **waits for that thread's task to finish**:

```sh
node recipes/ozi/task.mjs --thread "$THREAD_ID" --cwd "$TASK_DIRECTORY" -- \
  sh -c 'ozi thread "$THREAD_ID" --home "$OZI_CAPTURE_HOME" --message "$TASK" --json && ozi wait thread "$THREAD_ID" completed --home "$OZI_CAPTURE_HOME" --json --timeout 120'
```

Run this inside the capture environment so the generated `phoenix` command and capture variables are inherited, or explicitly supply `--phoenix` and `PHOENIX_CAPTURE`/`PHOENIX_HOME`. A submission-only command ends the marker too early. Markers never fail the task. The transcript reader gives every per-thread record its filename's thread ID and maps observed Claude query/result boundaries to task markers. Other provider lifecycle records remain verbatim metadata; it does not fabricate an end for a rotated or interrupted log.

Ozi's model/MCP wire traffic does not reliably carry its orchestration thread ID. With overlapping tasks, evidence lacking its own key or a proven model/tool pairing remains unattributed; a marker is not permission to guess. Check that coverage before selecting a Moment.

## Replay and fidelity

The descriptor's image is the Linux Node base, not an installed Ozi distribution. Build a digest-pinned image containing the exact Ozi server artifact, its Linux provider executable/dependencies, and Phoenix's sandbox relay. Supply the real server harness contract (`serve`, readiness and one-task submission) to runner. Never mount a native auth home, personal database, or session logs into Replay. Credentials remain host references only for live model continuation; echo uses recordings.

Export the selected capture through setup, approve its check, and run `node packages/cli/src/replay.ts echo --request replay.json`. Inspect each attempt's `fidelity.json`, not just the command exit code. A log-only echo that stops on missing model/MCP wire evidence is a coverage limitation, not proof of a faithful replay. The Node clock probe leaves monotonic clocks real; native statically linked provider binaries may retain real wall time, which the fidelity report must say.
