# Answer

## Emulators

`Emulators.start(configs, () => clock.now(), onDifference?)` creates independent plugin processes. Each config is `{plugin, options}`, where `options` is plugin-host's `ServingOptions`: a sandbox, explicit mounts, a private clock file, and container-local Snapshot/seed paths. Give each sample and connector its own clock file and sandbox. Pass the world as the third argument of `replayCtx`; the registered emulator resolver follows recorded answers (and the overlay when installed).

`answerCall` mirrors earlier answers into the emulator so recorded writes do not leave its world stale. Frozen-prefix callers must also `await world.observe(call, answer, exchange.observedAt)` before serving the recording. The engine does this automatically when given `emulators`; it writes differences as `fidelity.emulator_differences` trace events and exposes `engine.state(connector)` for end-state checks. Unsupported mirrored writes and plugin failures stop the sample. `skip_resolvers: [emulator]` disables both serving and mirroring in the engine. Always close the world; `engine.close()` does so.

The replay answer chain over one run's evidence. `buildIndex` turns trace events (run order, from a capture view or a bundle's run evidence) into exchanges, each with its call key, read-only flag from the locked classification, write history and whether it is in the frozen prefix of the requested start point. `replayCtx` holds one sample's state: the write history per connector and the exchanges already served.

`answerCall` runs the resolvers in `resolvers/index.ts`, in that order, skipping any a manifest removes for the connector, and returns the first answer. When every resolver misses it returns a divergence with each resolver's reason; it never falls back to a live connector. Each resolver is its own module, so a later resolver is one file and one line in that list. The recorded resolver serves a current exchange from the continuation with the same key byte for byte, the k-th call gets the k-th answer, and a read-only, non-volatile call past the recorded count gets the last current observation as `derived` ("repeat of last observation") unless `repeat_reads: false`. An exchange is current only while its stored write history equals the sample's, so a recording never answers for a world the candidate changed or a write it skipped.

`matchFrozen` serves a call in the frozen prefix from the recording and returns a `prefix-drift` divergence when the recording has no such call. `comparePrefixRequest` compares a frozen-prefix model request with the recorded one: history must match (the first differing field is named), configuration differences are returned as `prefix_edits`, and every recorded tool call must name a candidate tool with arguments its input schema accepts. `checkModelRequest` refuses non-inference operations, provider-run access to outside systems and provider-held conversation state.

## Recorded layout read here

- **MCP**: one event per JSON-RPC message on the connection's stream, `call` for harness-to-server and `result` for server-to-harness, body as received. Requests pair with responses by id. Server messages while a request is open belong to it and are replayed before its result; a harness reply to a server request is compared with the recorded one. Non-`tools/call` methods are protocol traffic and never enter a write history.
- **HTTP**: one stream per exchange: `meta` (request head JSON), `call` (request body), `meta` (response head JSON), `result` (response body). The op is `METHOD host/path`; arguments are the query string and the decoded body.

Normalized MCP arguments are `params.arguments` for `tools/call` and `params` without `_meta` otherwise. The core removes no other argument path.
