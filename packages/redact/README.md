# Redact

Both entry points are pure, asynchronous transformations of a `WireMessage` (`url`, `headers`, UTF-8 `body`, optional `contentType` and `contentEncoding`). They never read config, files, environment keys or network. The caller supplies a private HMAC key of at least 32 bytes. Store that key in `PHOENIX_HOME`; this package does not manage it.

`stripSecrets(message, {hmacKey, patterns?})` strips auth headers, URL credentials and secret query values, secret-named JSON fields or line assignments, and recommended secretlint patterns. JSON fragments inside SSE/JSONL framing are scanned too, and URL-encoded form fields retain their boundaries. It scans assembled messages, not individual transport chunks: the collector must retain the scanner's look-behind/unfinished message before giving any bytes to the spool. JSON replacements preserve the surrounding original bytes, including whitespace and unknown fields. Capture does not scrub personal data. Equal secret values share an HMAC placeholder across locations; audit entries contain only locations and rule names.

Supply the content encoding explicitly. gzip, deflate, br and zstd bodies are decoded for scanning. If unchanged, the original encoded bytes are returned. If changed, `msg.body` is decoded, `msg.contentEncoding` is cleared, and `originalEncoding` tells the caller what to record for replay re-encoding. The original wire headers remain evidence. Unreadable bytes/media stay local unchanged with `msg.secrets: unscanned` and an `unscanned` location.

`scrubPersonalData(message, {hmacKey, detector?})` uses OpenRedaction's local lite detector by default, with logs, cache, audit and optional subsystems disabled. It scans JSON keys as well as values, form fields, and decoded URL components. Use one pack-specific HMAC key for every manifest, check literal, fill and data file; equal detected values then have the same placeholder everywhere. A `PersonalDataDetector` can supply additional entity/name detection without adding I/O here. Pattern detection cannot guarantee names in arbitrary prose and retains the library's pattern validators. The pack caller recomputes call keys and seeks approval of the changed revision.

Packing removes unreadable media and every body marked `secrets: unscanned`, returning only its size and reason in `withheld`. Do not include those bytes in an archive. Neither function logs input or includes original values in its change report.

The reviewer-proven regressions run from the repository root with `node --test tests/redact-*.test.mjs`.
