# Google Calendar

An optional, separately installable Phoenix plugin implementing [plugin interface v1](../../spec/plugin.md). It imports no Phoenix internals. Pack with `pnpm --dir plugins/google-calendar pack`, install the tarball in the caller's plugin install root, and pass that directory to `findPlugins`. Node 24 or later runs the commands without a build.

## Live Google Calendar adapter

The raw [`@cocal/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp) server does **not** implement the contract below: it uses hyphenated tool names, `eventId`, account/calendar arguments, and `event`/`events` response envelopes. The installed `phoenix-google-calendar-mcp` command adapts that dialect (verified with version 2.8.1) using the MCP SDK:

```sh
phoenix-google-calendar-mcp primary normal node /path/to/google-calendar-mcp/build/index.js
```

The first two arguments pin one calendar and one authenticated account nickname; remaining arguments launch the upstream stdio server. Configure that server's OAuth environment normally. Tokens stay with the upstream server; the adapter never reads them. Give the harness this adapter as its `calendar` MCP server, and use the same command for capture-time reads.

`list_events` requires `timeMin` and `timeMax` and optionally accepts `privateExtendedProperty`. It returns the upstream events array without changing event fields. These bounded lists do not establish collection completeness. `get_event` unwraps one event. `move_event` supports only non-recurring timed events, sends only start/end through the upstream PATCH operation, suppresses notifications/conflict checks, and reads the committed event back so its full returned state—not request fields or an acknowledgement—updates the overlay. Start/end require explicit offsets. Recurring/all-day writes and arbitrary updates are rejected; recurring series/instance ids and fields remain readable unchanged. Google may return an equivalent instant with a different offset; consumers must not compare local clock strings without their offsets.

## Supported MCP contract

Opt in only for an MCP adapter configured for **one calendar**, with these tool names and payloads:

| Tool | Arguments | Successful payload |
| --- | --- | --- |
| `list_events` | `{}` for a complete, unpaginated calendar, or adapter-specific filters such as `{date: "2026-11-16"}` | An array of events |
| `get_event` | `{id: "event-id"}` | One event |
| `move_event` | `{id: "event-id", start: "…", end: "…"}` | The full updated event |

An event has a string `id`; its other fields are opaque and preserved. Payloads are MCP `structuredContent` or JSON in one text content block. Names alone do not establish compatibility. Do not enable this map for paginated lists, multi-calendar id namespaces, or adapters with different argument/envelope shapes. Raw Google Calendar HTTP routes and other MCP dialects remain generic recorded replay; this package does not claim to implement the Google API.

## Fidelity and replay

The descriptor's `stateful` tier is a **ceiling achieved by the entity overlay plus recorded writes**, not an independent Calendar emulator. Supply `descriptor.entity_map` to the engine's `entityMaps.calendar`, and its `read_only` operations to the connector policy with `source: "plugin"`. Discovery alone does not configure replay or authorize capture.

Captured events support derived gets by id. Only an observed, unfiltered, unpaginated list establishes a complete collection from which the overlay can derive new lists. Filtered/date lists contribute events but not collection completeness; their list answers stay recorded. There are no declared list filters because the overlay's equality/range filters do not implement Calendar date-window semantics. Unknown ids in incomplete collections miss.

A recorded `move_event` reply updates the entity, so subsequent overlay reads see the moved times. A move not supported by a recorded answer is a miss, not a fabricated write. Recurrence rules, exception identity, attendee flags, ids and timestamps are retained verbatim, never expanded or regenerated. Recurrence expansion, search, permissions and unsupported operations are misses. The run's actual fidelity follows the resolvers used, not this ceiling. There is deliberately no `serve` command and no dependency on `emulate`.

## Capture

Explicitly call `capturePlugin` with this installed descriptor and a separately authorized stdio MCP target. The sidecar reads only the supplied connector segments and their referenced blobs. It repeats observed `list_events` calls and fetches ids observed in tool arguments or successful event payloads with `get_event`. Both operations are declared read-only; `move_event` is never planned. The host owns the separate upstream connection, timestamps, redaction, prefetch storage and timeout. The sidecar makes no network calls.

Coverage always reports the event collection as incomplete: observed ids and windows do not prove a vendor-wide snapshot, even when the sidecar finishes successfully. Captured error replies remain recorded observations, not empty successful state.

## Proof boundary

The reference harness's calendar tools are the development stand-in, not Google traffic. They provide the three tools above but require a date on lists, so they cannot prove complete-calendar enumeration. The live adapter is a narrow bridge to Google's MCP server, not a Google API emulator. Recurrence expansion and PATCH behavior come from the real upstream; replay supports only recorded writes. The plugin kit's serving interface requires a proof adapter for this no-emulator plugin; such a report measures the recording/overlay chain, not independent vendor fidelity.
