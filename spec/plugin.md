# Plugin descriptor

`phoenix-plugin.json` describes a separately installed connector plugin (ARCHITECTURE.md section 3.15). `phoenix_plugin` is the plugin-interface major version it implements. It declares the connector name, how to recognize the connector (MCP server names, hosts, CLI commands), its declared tier (a ceiling, never proof) and the operations it covers, its read-only and volatile operations, versioned key rules that remove argument paths from call keys, an optional entity map per tool (kind, entity type, id and item paths, how a list shows it is complete, and equality or range filters), and up to two commands: `capture` (the sidecar) and `serve` (an emulator at `http` or `tool` level). Both speak newline-delimited JSON on stdio or plain HTTP.

## Process protocol, major version 1

The host discovers descriptors in explicitly supplied package directories or install roots (including scoped packages). It validates the descriptor before launching anything. Command arrays are executed without a shell. Capture commands run beside the harness; serve commands always run through `Sandbox`, with only explicitly supplied environment values and mounts. A replay caller mounts the installed plugin and Snapshot and sets the container working directory to the plugin's path. Paths in initialization are container paths for replay processes.

Requests are JSON objects with `phoenix_plugin: 1`, an integer `id`, `method` and a `params` object. Replies repeat the version and id and contain exactly one outcome:

- `status: answer` with `value` (including an explicit `null` for a successful empty result).
- `status: unsupported` with `reason`, meaning the operation missed and the answer chain continues.
- `status: invalid-input` with `reason`, meaning the input cannot be used.
- `status: execution-failure` with `reason`, meaning execution failed, never an empty success.

The host first sends `initialize` with optional `snapshot`, `seed`, `now` (the engine's clock endpoint), `segments` (capture segment paths), and `read_only` (the descriptor's declared read-only operation names). The plugin replies `answer` when ready. `call` takes `op` and `args`; in capture mode the host refuses a `call` not in `read_only`. `state` asks for emulator state for `end_state`. `capture` takes the sidecar's capture request. The connector-specific input and answer stay opaque to the host. Capture orchestration and coverage belong to the capture caller, not this protocol transport.

For `stdio`, each request and reply occupies one newline-terminated line on stdin/stdout. Requests may overlap and replies are matched by id. Diagnostics go to stderr. For `http`, the launched process prints one readiness line on stdout: `{"phoenix_plugin":1,"ready":{"url":"http://127.0.0.1:9000/plugin"}}`. The host POSTs one request to that loopback URL and expects HTTP 200 with one reply JSON object. Redirects are not followed. Inside a replay, HTTP requests travel through the private relay channel to the plugin's loopback listener, never through a published container port.

Unknown versions, malformed replies, a closed protocol stream, and process death are host errors. A pending request fails instead of substituting an answer or an empty world. Calls have a host-real-time timeout (30 seconds by default); the host never retries an operation. The runner owns interrupt/resume decisions.

## Emulator serving and comparison

`startServingPlugin` is the replay-serving adapter. Initialization supplies `snapshot` and `seed` as container paths, and `now: file:///phoenix-clock`. That read-only clock endpoint is updated from the engine's virtual clock before each request; libfaketime drives the process clock. Each `call` and `state` also carries `now` as an ISO timestamp. Calls on one plugin are serialized. No outbound connection is forwarded, including connections to the engine relay; local HTTP protocol requests still use the private channel. Mount only the plugin, its Snapshot/seed and its clock, with no production credentials.

A serving `call` carries `surface`, `layer`, `op`, `args`, and `raw: {body, head?}`. `body` is a canonical base64 string of the request bytes; `head` is the HTTP request head when applicable. An `answer` value is `{body, head?}` with the response body in base64. HTTP heads contain `status`, optional `statusMessage`, and an alternating name/value `headers` array. HTTP plugins return identity-encoded bodies and matching headers. MCP bodies are complete JSON-RPC responses with the request's id. A `tool` plugin covers MCP or CLI calls; an `http` plugin covers vendor-API calls. Operations not in the descriptor are unsupported, never guessed. State replies remain connector-specific JSON.

The answer chain mirrors calls answered by earlier resolvers into the emulator, including frozen-prefix calls at their recorded times. A differing response is reported while the recording remains authoritative. An unsupported read is a miss; an unsupported mirrored write stops the sample because the emulator's state could no longer be trusted. Invalid input, execution failure and malformed answers are errors, never fallback answers.

`plugin-kit` accepts ordered recorded exchanges (request/response bytes, normalized operation/arguments, observation time and optional intervening messages) and an optional expected end state. It starts a fresh sandboxed plugin, compares exact response bytes and HTTP heads, also reports JSON-field differences, reports unsupported/intervening protocol behavior, and queries final state. It never normalizes away timestamps, ids, recurrence or attendee fields. Without an expected end state it returns the actual state but cannot claim end-state equivalence.
