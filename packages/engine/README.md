# Engine

`startEngine` is the replay-side server for one sample. It builds the answer index from the run's evidence, writes the sample trace as a capture directory in the live format, and hosts the taps with responders as their backends. `accept` takes a relay connection (`{ destination, stream }`, as `EngineChannel` yields them). Its destination host selects a CLI shim in `routes.cli` or an MCP stdio shim in `routes.mcp`; other connections enter `gateway`. HTTP requests use an explicitly bound path in `routes.mcpHttp` for MCP Streamable HTTP, or a host in `routes.http` for direct HTTP and the model route. For example:

```ts
routes: {
  cli: { "phoenix-date": "date" },
  mcp: { "phoenix-calendar-stdio": "calendar" },
  mcpHttp: { "/mcp/calendar": "remote-calendar" },
  http: { "phoenix-model": "model" },
}
```

MCP HTTP serves the recorded JSON or SSE response, including the recorded protocol metadata, session headers, event IDs, standalone GET and DELETE behavior, notifications, cancellation and resumption. Request IDs in terminal JSON-RPC replies are rebound to the candidate's IDs. Stream chunks wait for the calls that preceded them in the recording, so a server-initiated request can be answered on another POST before its originating stream continues. An unseen lifecycle operation, session/cursor or server-request reply diverges. There is no protocol discovery, invented success or live tool connection.

## CLI shim contract

A CLI connection is bidirectional UTF-8 JSON Lines over the relay's byte stream. The first outbound line is a `CliInvocation` (the object `cliTap` passes as `Backend.open().meta`):

```json
{"argv":["date","+%F"],"cwd":"/candidate","env":{"LANG":"C.UTF-8"},"terminals":{"stdin":null,"stdout":null,"stderr":null}}
```

Every following line, in either direction, is `{ "stream": number, "bytes": "base64", "last": boolean }`. Outbound stream 0 is stdin (`last: true` closes it); outbound stream 3 carries an encoded CLI signal or resize control. Inbound streams 1 and 2 are stdout and stderr; inbound stream 3 carries `{ "type": "exit", "code": number|null, "signal": string|null }` as base64-encoded JSON. `last` is a frame boundary, not a command exit. The shim returns or re-raises the exit control, not TCP EOF. A `cliTap` with a byte-channel-backed `Backend` supplies descriptor detection, raw terminal handling, signals and resizes without duplicating them in the runner.

The invocation key contains the argv array, cwd, allow-listed environment and terminal descriptors. The runner must explicitly map container cwd/environment values to their recorded equivalents when materializing a recording; the responder does not discard these fields or join argv into a shell string. Recorded stdin and controls are checked in interaction order, independent of stdin chunk boundaries, before dependent output is released. No command is launched, and local file effects are not recreated.

Until every exchange of the frozen prefix has been served, model requests get the recorded response after `comparePrefixRequest` and tool calls get their recorded results; the first difference stops the sample with a `prefix-drift` divergence. With `model.loginContext`, declared login-context blocks are left out of the comparison and each difference in them is written as a `fidelity.prefix_uncompared` meta event. From then on model requests go through the model route (inference operations only, the real credential from `model.provider.headers` added here, no redirects followed, the `Date` header in virtual time) and tool calls go through the answer chain. Every event, including each answer, is synced to the sample trace before the answer is sent. `stopped` resolves with the first divergence (also written to the trace) or with an interruption such as a provider transport failure, and every open connection is then closed. A `start-point` meta event marks where the continuation begins and lists `prefix_edits`.

`VirtualClock` starts at the run's captured start time and is re-anchored to the captured time at the start point when the prefix ends. `onAnchor` lets the runner rewrite the sandbox clock file.

## Runner recovery and model selection

Pass the original run as `evidence` and the interrupted attempt's trace as `resume`. Completed recovery exchanges form a namespaced frozen prefix; uncovered exchanges of the original requested prefix remain frozen too. Matching original exchanges are marked consumed, while the original continuation and write histories remain the answer-chain source. Recovered writes are mirrored into fresh emulators; a differing response is a prefix-drift divergence, not just a fidelity note. The sample emits `start-point` at the original requested cut and a separate `resume-point` at the recovery cut, so checks do not confuse recovery with the original continuation. `prefixComplete()` reports whether every imposed exchange has been matched, including in echo mode; echo never goes live.

`isModelDialect` validates a canonical dialect; `resolveModelDialect` also accepts a namespaced dialect label without exposing vendor names to runner. Version-relative inference paths are recognized when the provider base URL already contains the API version. Optional `model.selection: { id, parameters }` overrides the LIVE inference model and parameters (the URL model and `generationConfig` for the generate-content dialect). Frozen model requests still compare the candidate's history and report configuration edits. Provider HTTP 429 and 5xx responses are infrastructure interruptions; they are not retried and are not delivered as candidate outcomes. HTTP trace bodies are decoded for checks and retain their original content encoding for recovery.
