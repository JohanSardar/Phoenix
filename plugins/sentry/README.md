# Sentry

An optional, separately installable Phoenix plugin implementing [plugin interface v1](../../spec/plugin.md). It gives replays a working copy of Sentry, so a replay never reaches the real Sentry. It imports no Phoenix internals. Pack it with `npm pack` and install the tarball with `npm install --install-strategy=nested`, so the plugin folder holds its own `node_modules` when it is mounted in the box. Node 24 or later runs it without a build.

## How the copy works

The copy runs Sentry's own MCP server, `@sentry/mcp-server` 0.49.0, the code behind mcp.sentry.dev. Only the Sentry API under it is redirected. `src/route.mjs` is loaded into that server with `--import` and replaces `fetch`:

- When a moment is made, GET requests go to the real Sentry and are written down. Every other method is refused before it leaves the machine.
- In a replay, every request goes to the copy in `src/copy.mjs`, on the box's loopback. Requests to any other host fail.

The copy answers from the API replies in the snapshot. It also keeps the replay's own writes, so a read after a write shows the change:

- Resolving or reopening an issue (`update_issue` with only `status`) changes its status and substatus, adds the activity entry Sentry adds, and subscribes the signed-in user.
- Adding a note (`add_issue_note`) adds the note to the issue's notes and activity and counts it.
- Issue lists filtered with `is:<status>` drop or add changed issues, sorted the way the list asked.

Anything else is a miss, never a guess: an API request the snapshot does not hold, another kind of write, or a list the copy cannot filter after a write. On a miss the serve command answers `unsupported` and undoes the call's changes, so the answer chain goes on and the copy's state stays true. Generated ids and times differ from Sentry's.

## The snapshot

`phoenix-sentry-snapshot` (`src/snapshot.mjs`) is a stdio MCP server for taking the snapshot. It is Sentry's MCP server reading the real Sentry with GET only. Each tool answer carries the API replies behind it in `_meta["phoenix/sentry-api"]`. It signs in with the `sentry` CLI's stored login (`sentry auth token`), or with `SENTRY_AUTH_TOKEN` when there is no stored login. The login is read at run time and is not written anywhere.

The capture command (`src/capture.mjs`) plans the reads from the session's own Sentry calls: every read the session made, the signed-in user, the organizations, and the details and activity of each issue the session touched or saw (at most 25). All of them are declared read-only, and the host refuses a plan with anything else. Give the host this server as the `sentry` entry of the MCP settings it reads, for example:

```json
{ "mcpServers": { "sentry": { "command": "node", "args": ["<install root>/node_modules/@phoenix/plugin-sentry/src/snapshot.mjs"] } } }
```

The serve command reads its snapshot from a list of tool answers taken this way, or from a session moment whose `answers` hold them. The snapshot shows Sentry as it was when it was taken.

## Read-only tools

`phoenix-plugin.json` lists all 73 tools of the server and marks 48 of them read-only, from the server's own `readOnlyHint`. Phoenix treats only these as safe to repeat and to read when a moment is made.

## Proof boundary

Side by side with mcp.sentry.dev, the copy's answers differ in these ways. mcp.sentry.dev runs newer code than the latest release on npm:

- `get_issue_details` and `get_sentry_resource`: the real answer has an optional "Concerns Identified" hint when an event has no user. The copy's answer has a note that the stacktrace mixes first-party and third-party code.
- `update_issue`: the real answer also reports the issue's priority.
- Notes and activity entries made in a replay have new ids and the replay's times.

## The sentry command line

A `sentry` command run in a shell is answered by the real `sentry` CLI (0.44.1, a dependency of this plugin) in the box, with its Sentry API calls sent to the copy. `sentry-cli` is not served.

The copy answers from a mark's reads. When `phoenix mark` marks a live session that ran sentry lines, the capture command plans each read-only sentry line the session ran, again and in full (help and version need no data and are left out), then `issue view` by org/short id and by short id for each issue those lines listed (at most 10). The host runs each through `src/cli-snapshot.mjs` (`capture.reads`): the same CLI with the person's stored login and `route.mjs` in snapshot mode, so only GET reaches Sentry. It prints what the line printed and the API replies behind it, and the copy loads those replies. A sentry line whose API calls the snapshot does not hold comes back unsupported, and the reason names them. The read-only entries for the CLI are its list and view commands; nothing under `sentry auth` is read.
