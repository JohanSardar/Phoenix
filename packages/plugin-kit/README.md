# Connector test kit

`runPluginKit({ plugin, start, now, exchanges, endState? })` runs a separately installed plugin through `plugin-host`, in a fresh no-network sandbox. `start` is a `ServingOptions` object with container-local Snapshot and seed paths, explicit mounts and a private clock file. No vendor implementation belongs in this package.

The caller supplies ordered recorded exchanges: `id`, `surface`, `layer`, `op`, `args`, `request: {body, head?}`, `response: {body, head?}`, and `observedAt`. Byte bodies are `Uint8Array`s. The CLI can wire the answer index's exchanges directly into this API; the kit does not import answer or engine. Optional `during` and `after` messages are reported as unsupported protocol behavior, since the plugin call interface returns a single response.

The returned JSON report contains `attempted`, `matched`, `differences` and `endState`. Each difference names its exchange, kind (`content`, `protocol`, `end-state`) and JSON pointer, with expected/actual values. `/wire/body` preserves byte differences even when parsed JSON is equal. The final plugin state is always requested; pass `endState` to compare it. Initialization failures reject; call failures are reported rather than replaced with successes. The plugin is stopped even when comparison fails.
