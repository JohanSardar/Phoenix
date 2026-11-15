# Setup

Only the manual parts of setup live here so far. Connector discovery, gap filling, operation classification, tier choice and check drafting are not built.

- `createSnapshotMoment` turns a mark in a captured run into a draft bundle. The person names the run (capture and task key), the mark, the start point (`beginning`, `mark`, or any event at or before the mark), and each connector with its surface. The run's events are copied whole and in run order to `data/run.jsonl`; each named connector is `recorded`, `captured`, with an empty read-only list. The check draft is the person's own file (`check`), or, without one, a draft whose `intent` is the run's Correction (`kind: correction`, text in `body.inline`; `op: one-off` Corrections never become checks). The run's working-directory snapshot goes to `data/workdir/run.json`; ignored files are included only when the capture copied them and the moment doesn't turn them off, and otherwise are listed without content.
- `createScenarioMoment` publishes an authored Scenario directory (`moment.yaml` with `source: scenario` and seeded connectors, `check.draft.yaml`, `data/`, `checks/`) as a bundle and locks it through `approvals.autoLock` when the manifest sets `lock: auto`.

Neither writes `check.yaml`, the lock or the ledger; `phoenix check approve` does that through `approvals`.
