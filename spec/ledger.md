# Approvals ledger entry

The approvals ledger is an append-only JSON Lines file in `PHOENIX_HOME`, outside every workspace, written only by `approvals` (ARCHITECTURE.md sections 3.6, 3.12 and 6). Each entry holds the moment id and revision, how it was recorded (`approved`, `auto`, `accepted` or `pass-accepted`), who and when. A `pass-accepted` entry carries the result hash; every other entry carries the lock hash.
