# A replay resumes the harness's own session

When a harness can resume a saved session, a replay copies that session file, cuts it just before the user turn where things went wrong, and has the real harness resume from the cut inside the sealed box. The harness talks straight to its own LLM, the same way it does live. Phoenix answers only the tool calls, from the session's own recorded results first. A call the session never made gets an answer in this order (Johan's pick, JOH-55): a file read or write runs for real inside the box, on a copy of the project's files; a service with a working copy answers from the copy; anything else gets a made-up answer, labeled as made up in the result. The replay stops only when none of these applies.

We chose this because Johan asked for it in plain terms: "all you have to do is essentially resume the session with the same codex like they already can do", "why are we putting something in between the harness calling the model", and "the output from mcp should be enough". The earlier replay rebuilt the run from a recording at the LLM API and put Phoenix between the harness and its LLM. That needed a recorder in the live path, and it replayed something that was not quite the harness.

What it costs:

- The box opens one narrow way out: the addresses of the LLM hosts the recipe names, on port 443. Phoenix looks these up once before the harness starts. Everything else stays shut, DNS included. Nothing from Phoenix sits in the harness's connection to its LLM.
- Known limit, by Johan's decision on 2026-11-16: another site that shares the LLM provider's addresses, such as one behind the same CDN, can be reached on port 443. Closing it would need Phoenix to read the TLS hello in the LLM's path. Johan ruled that out: "adding the phoenix gate between harness and llm is way too complicated and ruins the thing". Don't add such a gate.
- The box needs the harness's own login for that one LLM provider. It is copied in for the run only, and never goes into a bundle, a trace or git.
- The box's clock is set to the moment's time, and runs on from there. pi's recipe moves only the clock pi's own JavaScript sees. A faked clock in the TLS library would reject the LLM's current certificate for any moment older than it.
- A harness with no resume command can't use this. It replays from the beginning instead.

Harness specifics (how to read the session, how to cut it, how to resume, which LLM hosts it uses) live in that harness's recipe. Nothing in the core names a harness.
