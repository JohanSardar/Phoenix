I settled each disagreement against the spec's words first and the goal second.

1. **Durable admission versus availability-first capture.** Capture releases the final frame of each message once its redacted record is written to the operating system. It syncs off the call path and keeps the agent running when storage fails, with the gap visible. SPEC §3 says capture runs "in production, without changing what the agent does", and halting an agent between two real writes changes what it does most of all. A process crash still loses nothing delivered, because a message is in the OS before its last frame is released. That covers the goal's "a crash loses nothing". The remaining exposure is one unsynced batch at a power loss. Since this trades two stated aims against each other, it is Question 1, with the stricter levels spelled out.

2. **Replay from the mark.** The spec promises mark replay and a three-item harness contract. Re-running the candidate against recorded answers, with history frozen, configuration editable and every request checked, is the one mechanism that delivers both for a brand-new harness and for the reference harness. I kept the other position's honest limits. Local file effects of recorded commands are named in the fidelity report, and harnesses that drift on echo fall back to replay from the beginning. Whether a native-continuation option is worth a fourth contract item is Question 3.

3. **Recovery after prefix drift.** Resuming from the sample's own trace is the default, and every attempt is kept. Starting a fresh attempt is allowed because the spec asks the system to recover on its own. I added two guards so it cannot bias results. An attempt that already broke an irreversible expectation keeps that failure. A second interruption from the same cause leaves the sample unassessed instead of retrying.

4. **Discounted versus incomplete, and how taint works.** Both sides already allowed a discounted pass. The spec says "a pass can be trusted or discounted" and "kept out of the pass/fail decision where possible". I chose the simple forward-in-time taint rule, because finer dependency through a model's context cannot be established. A related point: the spec defines a pass as "did better than the baseline". So a target whose baseline already meets the check can still pass if the candidate beats the baseline, and the result notes that the failure did not reproduce.

5. **Trust boundary.** Both sides converged on keeping the engine, evidence and credentials outside a sandbox with no route out. For the VM I took QEMU `-nic none` with a single virtio-serial channel over restricted user networking. It leaves no network device at all, which matches the stated contract exactly.

6. **Repeating a recorded read.** In a frozen world with no writes since the last observation, the spec's "answers from the frozen copy" says the answer is the same. Refusing it would make the common double-check diverge. So a repeat of an approved read-only call returns the last current observation, labeled `derived`. Volatile and time-relative operations are excluded by the plugin, and a manifest switch can turn repeats off.

7. **Who owns the overlay.** I chose a declarative entity map in the plugin descriptor, interpreted by a small core. The spec's own overlay example is a single-event lookup answered from an earlier list, and a descriptor covers that with no connector code. Richer semantics go to emulators, with exactly one state holder per connector. Crash recovery rebuilds state from the sample trace with a seeded emulator, and the rebuilt answers are compared against the trace.

8. **Locks and git.** Approval authority lives in a ledger outside every workspace, and the bundle lock is its portable record. That answers the concern that checksums alone enforce nothing. Workspaces use git internally, with a private repository for harnesses outside git, so the harness itself never needs git. New files under editable paths are included, and ignored files never are.

Smaller choices:
- Unscanned media is withheld by default, because the spec says personal data is redacted when recorded. Keeping it is offered in Question 7.
- Checks take each action from exactly one source (the tap, or the model record for tools nobody tapped), so nothing is counted twice.
- Sample counts and any capture-overhead limit stay out of the design and are listed as questions.

I checked the 2026-07-28 MCP changelog and transports page, Docker's `none` and `--internal` docs, libuv's `F_FULLFSYNC` handling, Node's type-stripping status, and the emulate, Backlot and mockttp pages. The QEMU, harness-config and remaining library links are cited as given and were not re-fetched.
