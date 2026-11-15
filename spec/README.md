# Phoenix spec

Versioned JSON Schemas (draft 2020-12) for every language-neutral Phoenix format, as listed in docs/ARCHITECTURE.md sections 2 and 6. These schemas are the source of truth. `packages/formats` generates its TypeScript types from them and validates with them, never the reverse.

| Format | File it describes | Version field | Schema | Prose |
|---|---|---|---|---|
| Trace event | one line of `seg/*.jsonl`, `import/*.jsonl`, `notes.jsonl` | `v` | [trace.v1](schemas/trace.v1.json) | [trace](trace.md) |
| Working-directory snapshot | `workdir/<run>.json` | `phoenix_workdir` | [workdir.v1](schemas/workdir.v1.json) | [workdir](workdir.md) |
| Moment manifest | `moment.yaml` | `phoenix_moment` | [moment.v1](schemas/moment.v1.json) | [moment](moment.md) |
| Fill | a file in `data/fills/` | `phoenix_fill` | [fill.v1](schemas/fill.v1.json) | [fill](fill.md) |
| Success check | `check.yaml` | `phoenix_check` | [check.v1](schemas/check.v1.json) | [check](check.md) |
| Lock | `moment.lock.json` | `phoenix_lock` | [lock.v1](schemas/lock.v1.json) | [lock](lock.md) |
| Approvals ledger entry | one line of the ledger in `PHOENIX_HOME` | `phoenix_ledger` | [ledger.v1](schemas/ledger.v1.json) | [ledger](ledger.md) |
| Replay plan | `plan.json` | `phoenix_plan` | [plan.v1](schemas/plan.v1.json) | [plan](plan.md) |
| Replay result | the result file of a Replay | `phoenix_result` | [result.v1](schemas/result.v1.json) | [result](result.md) |
| Harness contract | `phoenix.harness.yaml` | `phoenix_harness` | [harness.v1](schemas/harness.v1.json) | [harness](harness.md) |
| Bindings | `bindings.yaml` | `phoenix_bindings` | [bindings.v1](schemas/bindings.v1.json) | [bindings](bindings.md) |
| Recipe descriptor | `recipe.yaml` | `phoenix_recipe` | [recipe.v1](schemas/recipe.v1.json) | [recipe](recipe.md) |
| Plugin descriptor | `phoenix-plugin.json` | `phoenix_plugin` | [plugin.v1](schemas/plugin.v1.json) | [plugin](plugin.md) |

[examples/](examples/) holds one hand-written example of each format. Check them with `pnpm --filter @phoenix/formats examples`.

## Versioning

These rules hold for every format (ARCHITECTURE.md section 6):

1. Each file carries an integer major version in its version field.
2. Within a major version, changes only add optional fields that are safe to ignore. Readers ignore fields they don't know and keep them when rewriting, so no schema closes its objects. A field that isn't safe to ignore needs a new major version.
3. A breaking change is a new major version with a new schema file (`<format>.v2.json` beside `<format>.v1.json`). A reader refuses a major version it doesn't support, with a message naming both versions.
4. Each schema has a stable `$id` of the form `urn:phoenix:<format>:v<major>`.
5. A plugin's `phoenix_plugin` is the plugin-interface major version it implements, and the host refuses others at load time.

YAML files use the JSON-compatible subset of YAML. Digests are written `sha256:<64 hex digits>`. Integers that may not fit a JSON number, such as monotonic nanoseconds, are strings.
