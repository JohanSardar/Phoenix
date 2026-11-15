# Pure wire codecs

All exports are pure and preserve raw evidence separately from decoded views.
Malformed JSON, UTF-8, SSE payloads, or content encodings return a reasoned decode
failure with the original bytes; a relay must never depend on successful decoding.

- `decodeMcp`, `encodeMcp`, `mcpInfo`, `lineFragments`, and `decodeMcpHttp` cover
  newline JSON-RPC and JSON/SSE across both protocol eras. Metadata identifies
  initialization-era versions and per-request versions without sending probes.
- CLI invocation/control codecs retain argv arrays, descriptor-specific terminal
  metadata, output channels, and code or signal. HTTP types retain raw header
  pairs and bodies; `decodeHttpBody` is an explicit read-time view, including
  gzip, deflate, br, and zstd. It never changes the stored exchange.
- `modelDialects` uses API shapes (`messages`, `chat-completions`, `responses`,
  `generate-content`), not provider identities. Each entry lists method/path
  inference operations, splits history from configuration, extracts tool-use IDs
  and streamed arguments, and identifies provider state or external access for
  the engine's safety policy. `decodeModelBody` reads JSON or assembled SSE while
  leaving every provider's format intact. Recipes choose the API shape.
- `canonicalJson` rejects non-JSON and invalid Unicode values and implements
  RFC 8785. `callKey` hashes exactly `{surface, connector, op, args}` with SHA-256;
  it never removes argument paths or changes array order or null/absent values.
- `completeCall` immutably appends a non-read-only call's key **on completion**,
  including failed writes. `sameWriteHistory` compares the complete ordered
  history, without guessing entity-level effects.
- `inferFormat` derives a JSON Schema from observed JSON values; strings remain
  strings even when they look like JSON. `inferToolFormat` also lists observed
  responses that fail a declared output schema. Empty evidence yields `{}`.

Mechanical transcript/fill derivations are deliberately not part of this ticket.
