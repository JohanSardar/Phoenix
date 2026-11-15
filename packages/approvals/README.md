# Approvals

The only code that appends to the approvals ledger, `PHOENIX_HOME/approvals.jsonl` (append-only JSON Lines, one fsynced line per entry). Reading it stays in `store`.

- `reviewDraft(root)` reads an unlocked bundle's `moment.yaml` and `check.draft.yaml` (or a `check.yaml` left by an interrupted lock) and returns what a person must see plus a `digest` of every file hash the lock would hold.
- `approveCheck(root, {home, who, reviewed})` refuses unless `reviewed` is still the current digest, then writes `check.yaml` (the draft's exact bytes) and `moment.lock.json`, verifies the bundle with `store.readMomentBundle`, removes the draft and appends an `approved` entry with the lock's hash.
- `autoLock(root, {home, who})` does the same for a Scenario whose manifest sets `lock: auto`, recorded as `auto`.
- `acceptMoment(root, {home, who, reviewed})` verifies a received bundle against its lock and appends `accepted` for that lock hash.
- `reviewPass(result, traces, moment, home)` / `acceptPass(result, {traces, moment, home, who, reviewed})` take a replay result file whose ledger entry names a lock in this ledger and whose verdict is a discounted `meets-check`, plus its sample traces. Blob bodies are read and verified from the blob store of the capture holding each trace (`<capture>/seg/<file>`). They refuse when a body can't be read or the traces hold no `provenance: synthesized` answers to show, and append `pass-accepted` keyed by the result file's hash.

An append first truncates a torn final line left by an interrupted append, which was never acknowledged.

A locked bundle is never relocked; a change needs a new moment revision. Revisions count distinct lock hashes per moment in the ledger, starting at `"1"`.
