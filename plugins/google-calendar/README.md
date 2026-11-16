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

An event has a string `id`; its other fields are opaque and preserved. Payloads are MCP `structuredContent` or JSON in one text content block. Names alone do not establish compatibility. Do not enable this map for paginated lists, multi-calendar id namespaces, or adapters with different argument/envelope shapes. The local server's own tools are covered by the working copy below.

## Working copy (`serve`)

The plugin has a working copy of Google Calendar for replays. It runs the real `@cocal/google-calendar-mcp` server (version 2.8.1, a dependency of this package) unchanged. Only the Google Calendar API under that server is replaced: `GOOGLE_CALENDAR_API_BASE_URL` points at an in-memory copy of the Calendar REST API (`src/google.mjs`). The server gets a made-up login in a temporary home, so a replay has no real login and no way to reach the real calendar. The sandbox also forwards no outbound connection.

The copy answers all 13 tools of the local server: `list-calendars`, `list-events`, `search-events`, `get-event`, `list-colors`, `create-event`, `create-events`, `update-event`, `delete-event`, `get-freebusy`, `get-current-time`, `respond-to-event` and `manage-accounts`. It also answers this package's adapter tools (`list_events`, `get_event`, `move_event`) by running the adapter over the same server, and the nine tools of Google's hosted Calendar MCP server (below).

What the copy knows comes from the Snapshot given at `initialize`: a JSON file `{ "answers": [{ "op", "args", "result", "observed_at" }], "adapter"?: { "calendarId", "account" } }` holding answers the session saw. The calendar list, each calendar's time zone, the events seen in each listed time window and free/busy all come from those answers. Writes then change the copy, so a read after a write sees it. That covers several calendars, repeating events and single changed occurrences, splitting a series, all-day events, time zones, guests and replies, free/busy, search, and the not-found errors the real service returns.

When the copy does not know enough, it does not guess. It answers `unsupported` with the reason, and the answer chain moves on. Examples: a time window it never saw listed, an event id it never saw that could exist, a calendar whose time zone it does not know, a Google Meet link, or a repeating rule it cannot expand.

The adapter tools only show Google's events, not the calendar list, so a session that used only the adapter does not tell the copy the calendar's time zone. Google writes each event time with the calendar's UTC offset, so the copy keeps every IANA time zone that matches all the offsets it saw. It answers a time only where all of those zones give the same local time, and answers `unsupported` anywhere they differ, for example across a daylight-saving change none of the seen times covers. While the copy serves the calendar, the engine turns off the entity overlay for it, so the copy has to answer the adapter reads the overlay used to answer.

Known differences from the real service, measured side by side against real answers:

- `created` and `updated` come from the replay clock, so they differ from the real ones by up to about one second.
- Ids that Google makes up (events created without an id) are new ids, not the real ones.
- `get-current-time` follows the replay clock. In the sandbox that clock is the recorded time, so it was 75 ms off.
- `manage-accounts` reports a login that expires in 2099, so the server never tries to refresh it.

The local server reads times without an offset, such as `originalStartTime`, in its own process's time zone. Set `TZ` in the plugin's environment to the time zone of the machine the session ran on, or those calls miss.

### Google's hosted server (the claude.ai connector)

Claude Code names the claude.ai Google Calendar connector `claude_ai_Google_Calendar` (its tools are `mcp__claude_ai_Google_Calendar__<tool>`), so the descriptor recognizes that name. The copy answers its nine tools from the same in-memory calendar (`src/hosted.mjs`): `list_calendars`, `list_events`, `get_event`, `search_events`, `suggest_time`, `create_event`, `update_event`, `delete_event` and `respond_to_event`. The shapes follow what that server answered in recorded Claude Code sessions:

- Answers are compact JSON with sorted keys, and empty lists are left out, so a search with no match is `{}`.
- After a write, an event shows its times in UTC, a `calendar.google.com` link, `availability` and `visibility`, and no reminders. `delete_event` answers `{ id, status: "cancelled" }`.
- When reading, an event shows its times in the calendar's zone (`list_events` uses its `timeZone` argument and adds `&ctz=` to the link), a `www.google.com` link and `useDefaultReminders`. `list_events` wraps the events with the calendar's `accessRole`, `defaultReminders`, `summary`, `timeZone` and `updated`.
- `suggest_time` answers the free stretches of the window that are at least `durationMinutes` long, in the asked zone.
- `respond_to_event` on an event without the user as an attendee is the error Google gives: "Cannot respond to event: The current user is not listed as an attendee on this event."

The copy learns from the hosted server's own answers in the snapshot: the calendar list, every event of a `list_events` window (without `fullText` and without a next page), events from reads and writes, deletions, and each search with the events it found. It answers `unsupported` for what it has not seen answered live: a window it never saw listed, a search it never saw (the server searches by meaning, so the copy repeats only a search it saw with less than a full page, and only while no event has changed since), guests, Google Meet, repeating or all-day writes, a time with an offset or without `timeZone`, `suggest_time` for anyone but the user, paging, and a recorded response to an invitation.

Compared call by call with four recorded sessions (each call asked after teaching the copy every real answer before it), every call the copy answered matched, apart from ids Google makes up, the links built from them, and `created` and `updated`, which follow the replay clock and differ by up to a second. The calls it did not answer were ones nothing before them could tell it about, such as a session's first `list_calendars`.

Install for a replay with `npm install --omit=dev` inside the unpacked package, so its `node_modules` sits in the plugin folder. The runner mounts only that folder.

## Entity overlay

Without `serve`, the descriptor's entity map still lets the engine's overlay answer adapter reads. Supply `descriptor.entity_map` to the engine's `entityMaps.calendar`, and its `read_only` operations to the connector policy with `source: "plugin"`. Captured events support gets by id. Only an observed, unfiltered, unpaginated list makes a collection complete. A recorded `move_event` reply updates the entity. A connector served by the working copy has no overlay state.

## Capture

Explicitly call `capturePlugin` with this installed descriptor and a separately authorized stdio MCP target, or take a mark with `phoenix mark`, which runs the same capture against the session's own calendar server. The sidecar reads only the supplied connector segments and their referenced blobs, and plans read-only calls only. A capture reads more of the real calendar than the agent touched, so the copy can answer calls the session never made:

- Through the local server: the whole calendar list, with each calendar's name and time zone; every event in each time window the session listed or searched; each event named in a call; and the series master of every repeating occurrence those lists returned.
- Through the adapter: each `list_events` window the session asked for again, and `get_event` for every event id seen. The adapter has no calendar-list tool, so the time zone comes from the offsets as described above.

These answers are real calendar data. A mark keeps them in its `services.json`, and a replay keeps the copy's snapshot under its emulator inputs, all on the machine that took them, in files only the owner can read. `move_event` and other writes are never planned. The host owns the separate upstream connection, timestamps, redaction, prefetch storage and timeout. The sidecar makes no network calls.

Coverage always reports the event collection as incomplete: observed ids and windows do not prove a vendor-wide snapshot, even when the sidecar finishes successfully. Captured error replies remain recorded observations, not empty successful state.

## Limits

For the hosted server, the read view never says whether an event blocks time. `suggest_time` therefore answers only where each event in the window is known: from a write answer, or because a `suggest_time` answer the copy saw fits only one choice for it. Otherwise it is `unsupported`, like a session's first `suggest_time` over a day with other events. Its default `list_events` order is unknown, so the copy answers more than one event only with an `orderBy`. The calendar's `updated` after a write is the write time rounded up to the second, which was up to a second off.

In a replay that starts from the beginning of a recording rather than resuming a session, the copy knows only the snapshot given in the replay settings. Without one it starts empty.
