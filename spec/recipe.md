# Recipe descriptor

`recipe.yaml` says how to point one harness at Phoenix without editing the person's config (ARCHITECTURE.md section 3.5). It declares the harness versions and login modes it covers, the routes it offers for each surface per version range and login mode, the model base-URL setting and dialect, where MCP servers are configured and in which format, which CLI commands to shim, an optional transcript reader with the harness versions it reads, the task-key locations for a server harness (an HTTP header, a `_meta` field or a JSON path), a sandbox image, the clock probe command (and `dont_fake_monotonic` for runtimes that need a real monotonic clock), and the `copy_ignored` option.

The transcript reader command runs in the recipe's directory. Its stdin is the
source file's exact bytes; `PHOENIX_SOURCE` names the original absolute path for
context only. Stdout is trace-schema JSONL with inline bodies and a `verbatim`
array on every event. Use a `meta` event with `op: transcript.coverage` and an
inline JSON body `{harness_versions: string[], carries: string[], lacks: string[]}`
to state coverage. Unknown records/versions are `meta` events with
`op: transcript.unread`; their inline JSON body names the source line/type and
reason. The importer strips secrets before storage, discards stderr, assigns the
capture and route, namespaces streams, and retains only wall time. Readers never
fill missing evidence. See packages/transcripts/README.md for failure and retry
semantics. These messages use the existing v1 trace schema; no new schema is
needed.
