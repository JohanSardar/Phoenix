# OpenCode 1.19.5

This recipe puts OpenCode back in a moment of a session it already saved. It
does not record anything live: OpenCode keeps every session in its own
database, and that is enough.

## Get the session

OpenCode has no session file. `export.mjs` copies OpenCode's database to a
temporary folder, runs OpenCode's own `opencode export` on the copy, and prints
the session one message per line. The original database is only read.

```sh
opencode session list
node recipes/opencode/export.mjs <session-id> > session.jsonl
```

Line 1 is the session. Line 2 and on are its messages, in order.

## Make the moment

```sh
phoenix moment create --session session.jsonl --recipe recipes/opencode/recipe.yaml \
  --at <line> --id <id> --check check.yaml <out-dir>
```

`--at` is a line of `session.jsonl`:

- A user message: OpenCode resumes just before it, with everything before it,
  and gets that message again.
- An LLM step (an assistant message): OpenCode resumes in the middle of the
  turn, just before that step, and the LLM takes the step again.

Tool calls are named `opencode.<tool>` in checks, for example `opencode.bash`.

## What happens in a replay

The box imports the cut session with `opencode import` and continues it with
`opencode run --session`. OpenCode talks to its LLM directly. The box can reach
only the LLM host of the moment's provider (`resume.llm_hosts`).

A plugin (`stand-in.mjs`) takes the place of OpenCode's built-in tools that
reach outside OpenCode: bash, read, glob, grep, edit, write, apply_patch,
webfetch, websearch, skill, task and question. It keeps their own descriptions
and parameters, and sends every call to Phoenix, which answers from the
session's own tool results. `todowrite` runs inside OpenCode, because it only
changes OpenCode's own to-do list.

For a step in the middle of a turn, OpenCode needs a message to start. The
plugin sends a marker message and takes it out before the LLM sees the
conversation, so the LLM sees exactly the session up to the cut.

## The harness

The harness folder becomes the session's working folder in the box. Put there
what OpenCode reads from a project:

- `AGENTS.md`: instructions.
- `opencode.json`: settings. `model` swaps the LLM: any LLM of the moment's
  provider, or of OpenCode Zen or Go.
  `tools` turns tools off.
- `.opencode/plugins/*.js`: plugins, for example one with a
  `tool.definition` hook that changes a tool's description.
- `opencode.patch`: a change to OpenCode's own source code, as a git diff
  against OpenCode 1.19.5. When it is there, the box applies it and runs
  OpenCode from source with bun instead of the release build.

OpenCode does not save its system prompt in the session. The harness folder is
what that prompt is made from, so put the instructions you use there.

## Login

`login.mjs` copies the provider's login from OpenCode's `auth.json` into the
box for one run, together with the OpenCode Zen and Go logins if you have
them, so a harness can swap the LLM to one of those. They are deleted after
the run and never go into a bundle, trace or git.

## Build the box image

```sh
docker build -f recipes/opencode/resume.Dockerfile -t phoenix-opencode-resume:1.19.5 recipes/opencode
```

Put the image ID and the path to `recipe.yaml` in the Workbench settings.

## Limits

- Merged with a gap (JOH-55, JOH-61): OpenCode replays that answer new calls were last seen working on the code that became commit ba9d924f, not re-run on the final code. The LLM account they use, OpenCode Go, was out of balance.
- Merged with a gap (JOH-55, JOH-61): made-up answers were last seen working on the code that became commit ba9d924f, not re-run on the final code. The simulator LLM they use, on OpenCode Go, was out of balance. No other LLM route on the Mac worked for it: DeepSeek was out of balance, the Zen and Kimi keys were expired or invalid, and ChatGPT's backend accepts only streamed replies, which the simulator doesn't send.
- Phoenix stands in only for OpenCode's built-in tools. A session that used
  MCP or plugin tools can't be cut yet: OpenCode doesn't save their
  descriptions.
- A `read`, `glob`, `grep`, `edit`, `write` or `apply_patch` call the session
  made gets the session's own answer, and the tool does not run. A new one runs
  for real in the box, on the copy of the project's files. Any other new call
  gets a made-up answer, labeled in the result.
- To skip the tool for a call the session made, the box runs OpenCode from its
  source with `stand-in.patch` applied. This is slower to start than the built
  OpenCode.
- In the box, OpenCode may read and write outside the project folder without
  asking, because everything there is a copy. A harness's own
  `permission.external_directory` rule still wins.
- The replays that proved this recipe did not run on the sessions' own LLMs.
  One session's LLM is retired, and the other's provider returned an error, so
  both harnesses named an OpenCode Go LLM in `opencode.json`.
- Permission rules on command patterns are not applied to stand-in tools.
- Subagents started by `task` are answered from the session, not run again.
- The resumed run uses the real clock.
