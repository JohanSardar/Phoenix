# Moment manifest

`moment.yaml` describes a Moment bundle (ARCHITECTURE.md sections 3.6 and 6). It names the moment (`id`) and its `source`: `snapshot` for a marked live run, which must name its `run` and `mark`, or `scenario` for a staged or seeded world. It records the default start point, the clock time and timezone, the prompt, the working-directory snapshot reference, the model (an alias marked as one), the harness name, tree digest and commit, and the recipe version.

Each connector entry gives its surface and capture routes, its tier, its data origin (`captured` or `seeded`), its coverage statement, its read-only operations and where each classification came from (anything but `plugin` is unverified), its plugin name and version range, its recorded tool list, its MCP protocol version and era, and its data files, each marked run evidence, capture-time or confirmation. A connector may allow the simulator (`allow_synthesized`), turn off repeated reads (`repeat_reads: false`), or remove answer-chain steps (`skip_resolvers`); a manifest can only remove steps, never reorder them.

`fills` lists each fill with its tag, basis and producer. `executable` names the custom-check files. `lock: auto` (scenarios only) and `include_ignored` are per-moment opt-ins. A packed revision adds `packed`: the hash it was packed from and what was scrubbed or withheld, by location.
