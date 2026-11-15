# Success check

`check.yaml` defines the right thing at a moment (ARCHITECTURE.md section 3.12). It holds the sample rule (`samples: { base, tiebreak }`), the evidence `scope` (`continuation` sees only what happened after the start point, `run` sees the whole run), deterministic expectations under `expect`, and an optional plain-language `intent`. A check has at least one of `expect` and `intent`.

Each expectation has exactly one kind: `called` (tool, optional args, optional times), `not_called`, `order` (tools in order), `max_calls`, `end_state` (a connector's state equals a file in the bundle), `final_text` (`contains` or `matches`) or `custom` (a module under `checks/`). An expectation kind this version doesn't know is refused, because it isn't safe to ignore.
