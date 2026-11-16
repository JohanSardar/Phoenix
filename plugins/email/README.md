# Email

A working copy of one Gmail mailbox for Phoenix. It is a separately installed plugin that implements [plugin interface v1](../../spec/plugin.md) and imports no Phoenix internals.

The copy answers two ways into the same mailbox:

- the claude.ai Gmail connector's 31 tools (MCP server name `claude_ai_Gmail`, ops `tools/call:<tool>`)
- the `himalaya` command (CLI surface, op `himalaya`)

A write through one is seen by the other. If the agent stars a message with himalaya, the connector's next search shows it starred.

## How it answers

`src/serve.mjs` speaks the plugin protocol on stdio at tool level.

- Connector tools are answered from the mailbox. The JSON has the same keys, order and text as the real connector.
- himalaya calls run the real himalaya 1.2.0 inside the box. The copy hands it a config that points at its own IMAP and SMTP servers on 127.0.0.1 (`src/imap.mjs`), which behave like Gmail's: label folders, `[Gmail]/Trash`, sent mail filed under Sent, and X-GM extensions. Only the connection settings are replaced. The person's other himalaya settings come from the snapshot.
- Writes change the copy and nothing else. The box has no network.
- When the copy does not hold what a call asks for, it answers `unsupported`. Examples: a thread it saw only part of, the body of a message it only saw in a search, the RAW form of a message it wrote itself, attachment bytes. The call then goes to the next answer source, which labels its answer.

## Snapshot

`initialize` reads a JSON snapshot:

| Field | Meaning |
| --- | --- |
| `account` | `{ email, name }` |
| `timezone` | IANA zone used for quoted reply dates |
| `labels` | A `list_labels` answer |
| `messages`, `drafts` | Messages and drafts already known |
| `answers` | Recorded connector answers `{ op, args, result, observed_at }` |
| `cut_at` | Answers observed at or before this time are the moment's past |
| `himalaya` | `{ top, accounts: [{ name, lines, default }] }`: the person's himalaya settings without connection or login lines |

The copy learns the mailbox from the answers in time order. A recorded send, reply or draft is replayed inside the copy and takes the id Gmail gave it. Gmail ids carry the millisecond the message was made, so the copy also takes Gmail's `internalDate` from the id.

## Read-only

The seven read tools are declared read-only: `search_threads`, `get_thread`, `get_message`, `list_labels`, `list_drafts`, `get_draft`, `download_gmail_attachment`.

himalaya is not declared read-only. The plugin interface keys read-only by op, and every himalaya command has the same op, `himalaya`. So `envelope list` and `message delete` cannot be told apart there.

## Capture

`src/capture.mjs` plans reads of everything the session touched through the connector: `list_labels`, then `get_thread` (FULL_CONTENT) for each thread, `get_message` (RAW) for each message, and `get_draft` for each draft. Every planned read is a declared read-only tool. The sidecar makes no network calls.

The claude.ai connector runs inside claude.ai. There is no local MCP command for the host to read through, so a mark reports the connector as not saved, and the copy starts from the answers the session recorded. The host has no CLI capture target, so himalaya reads are not planned either.

## Box

`Dockerfile` builds the box: Node 24, libfaketime for the moment's clock, and himalaya 1.2.0 from its GitHub release, checked against a pinned sha256 for arm64 and amd64.

```sh
docker build -t phoenix-email plugins/email
```

Pass the image digest as the plugin's image when you plan a replay.

## Differences from real Gmail

The plugin test kit was run on 38 answers recorded from the real connector. These differences remain:

- `historyId`: Gmail's counter jumps by amounts the copy cannot know.
- `sizeEstimate`: Gmail stores headers the copy does not write.
- New ids from send, reply, create_draft and update_draft: Gmail picks part of each id at random.
- `resultCountEstimate` and threads the copy never saw in a search.
- The real connector sometimes leaves out `structuredContent` and sends only the text. The text is the same.

## Limits

- himalaya's stdin is not passed. The CLI call reaches the plugin before any stdin is sent, so `himalaya message send` with the message on stdin gets an empty message. Passing the message as an argument works.
- Attachment bytes are not held.
- `create_label` and `update_label` answer only plain labels: a color or a nested name (with `/`) falls through, because no real answer for those has been recorded.
- A search with plain words falls through when any message the copy holds has content it never saw, because the copy can't tell whether those words are in it.
- himalaya output is compared only with the copy's own IMAP so far, not with himalaya against real Gmail.
