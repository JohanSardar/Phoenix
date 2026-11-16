# Phoenix

Phoenix takes an agent harness back to a moment of a run it already made, so you can change the harness and see whether it now does the right thing. The harness's own saved session file is the record. Phoenix cuts a copy of that file at the moment you pick, the real harness resumes from there inside a sealed box, and Phoenix answers its tool calls, so nothing in a replay reaches a real service. An outside agent, or you by hand, then edits the harness (its prompt, its config, the LLM it uses) and replays the moment until a check you approved passes. The changed harness is the same one you run live.

Nothing from Phoenix sits between a harness and its LLM. In the box the harness talks to its own LLM, with its own login, the same way it does live.

## Install

```sh
curl -fsSL https://phoenix.eilmer.si/install | sh
```

This installs the latest release for macOS or Linux (arm64 or x64) into `~/.phoenix`, with its own Node.js, and verifies the download's SHA-256 checksum. Pin a version with `curl -fsSL https://phoenix.eilmer.si/install | sh -s -- v0.1.0`. Run the same command again to upgrade, and delete `~/.phoenix` to uninstall. Replays need Docker or Podman. The optional tool proxies use git and Python 3.

## How it works

1. **Pick a moment.** Copy a session file your harness saved, and cut it at a line: `phoenix moment create --session <copy> --recipe recipes/pi/recipe.yaml --at 8 --id ask-first --check check.yaml moments/ask-first`. Use `--from-beginning` instead of `--at` to start at the session's first message with its original prompt. While the harness runs, `phoenix mark` also saves the world at that moment: the session line, a copy of the project's files, and what each service's read-only tools answer right then.
2. **Write down the right thing.** The check says what the agent should do at that moment, for example "call `list_events`, never call `move_event`". Approve it once with `phoenix check approve <moment>`; after that nobody trying to pass it can change it.
3. **Replay.** `phoenix workbench init` makes a workspace from your harness folder and moments, and `phoenix workbench startReplay` runs the moment in the box, by default twice, plus a third time when the two disagree. Each tool call gets an answer from, in order: the session's own recorded result; for a call the session never made, the copy of the project's files (file tools run for real on the copy), a service's working copy, or a made-up answer from a simulator LLM, labeled as made up. When none of these can answer, the replay stops and says why.
4. **Change the harness until it passes.** Connect an outside agent to the Workbench's MCP server, or edit the editable files yourself, and replay again. A pass counts only when it beats the unchanged harness on the same moment. `makePatch` gives you the change as a patch.

"Records" in this README means one thing: the harness saves its own session file, with nothing from Phoenix attached. Phoenix adds nothing live to make that happen. The optional MCP and CLI proxies (`phoenix capture`) can save tool traffic too; they never record the harness's LLM traffic. A moment made from such a capture alone, with no session file to resume, replays from the beginning only.

## What works, per harness

Each cell says what was seen and by whom: **Captain** (the agent that directs the build ran it on main itself), **worker only** (only the agent who built it saw it) or **not seen**. The run behind each "yes" is listed under the table. "New tool call" means a call the session never made.

| Harness | Records | Replays from a moment in the middle | Replays from the beginning | What answers a new tool call | Known limits |
|---|---|---|---|---|---|
| pi | pi's own session file. `phoenix mark` works on a live pi run: Captain (R1). | Yes: Captain (R2, R3). | Yes: worker only (W1). | File tools: the files copy, Captain (R3). Calendar: Phoenix's own copy of what the session saw, Captain (R3). Sentry: the Sentry copy, Captain (R4). Anything else: a made-up answer, Captain (R5). A new shell command: nothing yet, the replay stops. | L1, L2, L3, L4 |
| Ozi running pi | The pi session file behind the Ozi thread: Captain (R6). Mark: not seen. | Yes: Captain (R6). | Not seen. | As for pi. A calendar `get_event` answered from Phoenix's copy: worker only (W2). | L1, L2, L4, L5 |
| OpenCode | OpenCode's own session database; the recipe exports a copy: Captain (R7). Mark: not seen. | Yes: Captain (R7), but that moment's unchanged harness made no tool calls. Recorded answers then a stop on a new call: worker only (W3). | Yes, reaching a real "fails" verdict: worker only (W1). | The files copy and a made-up answer: worker only, on code before the merge (W4). On the merged code: not seen. | L2, L6, L7 |
| fx | fx's own session log and its side files, secrets stripped: Captain (R8). Mark: not seen. | Yes: Captain (R8). | Yes: Captain (R9), but Phoenix answered no tool calls in that run. | `read_file`: the files copy, Captain (R10). `edit_file` and `write_file` in a box: not seen. A new shell command: nothing yet, the replay stops (R9). Made-up: not seen. | L2, L3, L6, L8 |
| Codex | Codex's own session file: Captain (R11). Mark: not seen. | Yes: Captain (R11), but Phoenix answered no tool calls in that run. Recorded shell answers: worker only (W5). | Yes: Captain (R12), no tool calls answered. | Nothing yet: Codex reads through the shell, and a new shell command stops the replay (R11, R12). A new MCP call stops too. | L2, L3, L6, L9 |
| Claude Code | Claude Code's own session file: Captain (R13). Mark: not seen. | Yes: Captain (R13), but the passing answer made no tool calls. One recorded answer served: worker only (W6). | Yes: Captain (R14), on a moment with no tool calls. | Gmail connector calls: the email copy, Captain (R15). A new `Bash` call: nothing yet, the replay stops (R13). File tools on the files copy: not seen. Made-up: not seen. | L2, L3, L10 |
| mini-swe-agent | No resume command. The recipe writes a small session from a made-up moment. | No (the harness can't resume). | Yes, both samples finished with a real verdict: Captain (R16). Fail to pass: not seen. | Its shell calls are answered from the made-up moment's world: Captain (R16). | L11 |
| OpenAI customer service agents demo | No resume command. The recipe writes a small session from a made-up moment. | No (the harness can't resume). | Yes, 2 airline tool calls answered: Captain (R16). Fail to pass: worker only (W7). | Its function tools are answered from the made-up moment's world: Captain (R16). | L11 |

**Runs cited.** Captain runs are on main at the commit named.

- R1: two marks on live pi runs; the world was saved and each replay reached a verdict (main 14e06c1d).
- R2: a staged live pi run moved a meeting without asking; the unchanged harness fails 2 of 2, the outside agent's change meets the check 2 of 2 (main 5a9f270).
- R3: pi write and pi serve moments: answers came from the session, the files copy (the copy gained the new file) and Phoenix's calendar copy (main 5cd9459c).
- R4: Sentry moment, unchanged harness fails 2 of 2, the outside agent's second candidate meets the check 2 of 2; the note and activity came from the Sentry copy (main 6b2f22a5).
- R5: Sentry untaken-write watch: `update_issue` got a made-up answer, labeled, and the result flags the calls that came after it (main 14b44fbd).
- R6: a real Ozi thread with pi, cut from its pi session: fail 2 of 2, then pass 2 of 2 (main afc0ec4).
- R7: OpenCode `crew-report` moment: fail 2 of 2, then the second candidate passes 2 of 2 (main 0477735, again on ce72d7af).
- R8: fx `ci-notice` moment: fail 2 of 2, the second candidate passes 2 of 2; the LLM reached only chatgpt.com (main 8dcc6c0e).
- R9: fx from the beginning: fail 2 of 2, then pass 2 of 2; the unchanged harness stopped at its first new shell call (main 95e741e9).
- R10: fx new reads: one sample made 4 `read_file` calls, all run on the files copy (main 95e741e9).
- R11: Codex `lamp-relay` moment: fail 2 of 2 (stopped at the first new shell call), then 2 of 2 (main 21e24283).
- R12: Codex from the beginning: fail 2 of 2 (stopped at a new `pwd`), then 2 of 2 (main 5cd9459c).
- R13: Claude Code `website` moment: fail 2 of 2 (stopped at the first new `Bash` call), then 2 of 2; the box reached only api.anthropic.com (main 83aec45a).
- R14: Claude Code from the beginning: fail 2 of 2, then 2 of 2 (main af636271).
- R15: email copy through Claude Code: the unchanged harness fails, `send_message` answered by the copy; the outside agent's candidate passes, `reply` answered by the copy (main ce72d7af, one sample per run).
- R16: harnesses with no resume: mini-swe-agent's shell call answered by Phoenix, verdict fails; the customer service demo's 2 airline calls answered, verdict incomplete (main 6b2f22a5).
- W1: from the beginning on a real pi session and a real OpenCode session (the T3 moments work).
- W2: Ozi `get_event` answered from Phoenix's calendar copy (the Ozi everyday-setup work).
- W3: OpenCode `ota-push` moment: 3 or 4 calls per sample answered from the session, then a stop on a new call.
- W4: OpenCode new calls before the merge: 4 from the session, 9 from the files copy, 1 made up.
- W5: Codex replays where recorded shell answers were served from the session.
- W6: a Claude Code replay with one recorded answer served.
- W7: the customer service demo going from fail 0 of 2 to pass 2 of 2.

### Limits

- L1: pi's clock is set to the moment's time only for JavaScript's `Date`. `performance.now` and the TLS library keep the real clock.
- L2: From the box, another site that shares the LLM provider's addresses (behind the same CDN) can be reached on port 443. Closing that would need a gate in the LLM's path, and Johan ruled that out. Don't add one.
- L3: A new shell command gets no answer yet on any harness, so the replay stops there. Codex and Claude Code mostly read through the shell, so they stop often.
- L4: A pi-mcp-adapter question the session never asked (for example, describe a tool) stopped the replay when it was tried; whether a made-up answer now covers it was not seen.
- L5: Ozi runs change runtime files (caches and logs, not config) under `~/.pi/agent`.
- L6: OpenCode, fx and Codex run on the real clock, not the moment's time. fx can't use a faked clock: its TLS check to the LLM host fails.
- L7: An OpenCode session that used MCP or plugin tools can't be cut yet, because OpenCode doesn't save their descriptions. Neither test session ran on its own LLM: one LLM is retired, the other gave a stream error.
- L8: fx: MCP servers aren't started in the box, so a resumed fx sees no MCP tools. Blobs Phoenix can't scan for secrets are left out, and a call whose output was left out gets no session answer. `--change` isn't supported. A source change needs about 4 GB per build, so run the Workbench with `--concurrency 1` on 8 GB. Only sessions on the Codex subscription resume.
- L9: Codex: the box runs Codex 0.169.0, so its own tool descriptions and base instructions can differ from an older session's.
- L10: Claude Code pins its prompt and tool list in the session and ignores a prompt given on the command line, so the recipe writes `SYSTEM.md` into the session. A cut right after a tool result adds a "No response requested." line. The test sessions came from Claude Code hosts, not the plain terminal. From the beginning, the prompt is rebuilt from the session and host-only tools are missing. A repeat of a call from before the cut isn't answered from the recording.
- L11: The harnesses with no resume command reach only two LLM routes (OpenCode Go and a ChatGPT login). Their intent checks often go unjudged, so verdicts end incomplete.
- Made-up answers need an account for the simulator LLM. When it is out of balance, a call nothing else can answer stops the replay.
- A replay refuses to start when the harness's login has less than 15 minutes left. The box's copy of the login is deleted after every run.
- If the LLM refuses after the login step, pi and OpenCode still report "fails" rather than "could not run".
- The flag for answers that come after a write the working copy refused is written only on the session-resume path.
- A moment made from a Phoenix capture alone replays from the beginning only, and nobody has run that path on a real harness other than Phoenix's reference harness.
- Files copy: a folder outside git is copied without dot-files and dot-folders, so pi's `.pi` folder is left out.

## Working copies

A working copy stands in for one real service in a replay. It answers the way the real service would and takes the replay's writes, and the real service is never touched.

| Service | Ways in covered | Ways in not covered | How close the answers are | Seen |
|---|---|---|---|---|
| Sentry | The Sentry MCP server: issue details, updates, notes and activity. A write the copy can't take gets a labeled made-up answer, and later answers are flagged. | The `sentry` CLI. Deleting things (no MCP tool for it). | 13 real calls: 4 byte for byte, 3 differ only in ids or times, 6 differ by text the newer hosted server adds. | Captain (R4, R5) |
| Email (Gmail) | The Gmail connector, 31 of 31 tools, labels included. The himalaya CLI's piped input. | himalaya against real Gmail (blocked on an app password). A mark or resume made from himalaya calls. pi, which needs himalaya plus shell routing. A himalaya send that saves to "Sent", which the copy lacks. | 38 recorded answers: 12 exact, 23 differ only in values nobody can know in advance (ids, times), 3 real differences. | Captain (R15), one sample per run. Read-after-write: worker only. |
| Supabase | The Supabase MCP server 0.17.0, read-only, started the way Johan's launcher starts it: listing tables, SQL reads, logs and the other read-only tools. | A session recorded through the launcher itself. The Supabase CLI or psql through the shell. Logs for any window that isn't an exact repeat. A read-write session (never recorded). | 48 real calls: 45 byte for byte, 2 table lists in a different order (the same once sorted), 1 logs miss. 25 of 25 writes and errors match a real Postgres 17.6. | Worker only |
| Google Calendar | On main: Phoenix's own copy of the events the session saw (lists, gets and moves). The full copy of the local Calendar MCP server (13 tools) is in an open pull request. | Google's hosted Calendar MCP server. Three adapter tools when the calendar's time zone is unknown. | Full copy, 54 real calls: 17 byte for byte, 28 differ only in times, ids or clock, 9 unsupported (8 need Google-made ids mapped, 1 is a time window the copy never saw). | Phoenix's own copy: Captain (R3). Full copy: worker only. |
| Files | File tools run for real on a copy of the project's files: from git at the moment's time, or from the folder as it is today when it isn't in git. A mark's copy is served as it was at the mark. Phoenix never copies the home folder, login or settings folders, or a system folder, and caps everything else. | Shell commands (open work). `edit_file`/`write_file` in an fx box and Claude Code's file tools on the copy: not seen. | Not compared with a real service: writes land in the copy, and reads show the copy. | Captain (R3, R10); a mark's copy on main 6b2f22a5 |

## More

- [Spec](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Glossary](GLOSSARY.md)
- [Architecture decision records](docs/adr/), especially [0007: a replay resumes the harness's own session](docs/adr/0007-replay-resumes-the-harness-own-session.md)
- Each harness's recipe README under [recipes/](recipes/)

## Merging

Label a pull request `automerge` and it lands, squash-merged, once its checks pass.

License: MIT, see LICENSE
