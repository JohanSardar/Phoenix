# A replay resumes the harness's own session

When a harness can resume a saved session, a replay copies that session file, cuts it just before the user turn where things went wrong, and has the real harness resume from the cut inside the sealed box. The harness talks straight to its own LLM, the same way it does live. Phoenix answers only the tool calls, from the session's own recorded results first, and stops on anything it can't answer truthfully.

We chose this because Johan asked for it in plain terms: "all you have to do is essentially resume the session with the same codex like they already can do", "why are we putting something in between the harness calling the model", and "the output from mcp should be enough". The earlier replay rebuilt the run from a recording at the LLM API and put Phoenix between the harness and its LLM. That needed a recorder in the live path, and it replayed something that was not quite the harness.

What it costs:

- The box has no network of its own. Phoenix passes on a connection only when it goes to an LLM host the recipe names, on port 443, and its TLS hello names that same host. Phoenix reads that one name, never the content, and forwards the encrypted bytes unchanged. Everything else stays shut, DNS included, so the box can't reach a real service or another site that shares the LLM's addresses.
- The box needs the harness's own login for that one LLM provider. It is copied in for the run only, and never goes into a bundle, a trace or git.
- The box's clock is set to the moment's time, and runs on from there. pi's recipe moves only the clock pi's own JavaScript sees. A faked clock in the TLS library would reject the LLM's current certificate for any moment older than it.
- A harness with no resume command can't use this. It replays from the beginning instead.

Harness specifics (how to read the session, how to cut it, how to resume, which LLM hosts it uses) live in that harness's recipe. Nothing in the core names a harness.
