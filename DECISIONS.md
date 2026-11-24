# Decisions

## [2026-11-24] Loopback-only host and pinned debugger URL
**Decision:** `--host` accepts only loopback values (127.0.0.1, localhost, ::1). The `webSocketDebuggerUrl` must be loopback, `ws:`, on `config.port`, and under `/devtools/`.
**Alternatives considered:** Accept any `--host` (spec section 9 offers the flag), or trust the URL Chrome returns.
**Why:** Spec section 8 says the tool connects only to 127.0.0.1, and the debug port grants full browser control. Pinning the URL stops a hostile or odd discovery response from redirecting the connection.

## [2026-11-24] eval evaluates once, by reference
**Decision:** `eval` uses `callFunctionOn` with `returnByValue`, and falls back to an object preview for non-serializable results.
**Alternatives considered:** A by-value `Runtime.evaluate`, re-run by reference when serialization fails.
**Why:** The re-run executed side effects twice; a single evaluation keeps `eval` safe to use on real pages.

## [2026-11-24] reload clears buffers only after Page.reload succeeds
**Decision:** Buffers are cleared after `Page.reload` succeeds, using an id cutoff so events from before the reload are dropped.
**Alternatives considered:** Clear first, then reload.
**Why:** A failed reload must not wipe data the user still needs; the cutoff keeps pre-reload events out of the fresh capture.

## [2026-11-24] attach opens the new connection before detaching the old one
**Decision:** `attach` connects to the new tab first and detaches the previous attachment only on success.
**Alternatives considered:** Detach first, then connect.
**Why:** A failed attach (bad tab, Chrome down) leaves the existing attachment and its buffers intact.

## [2026-11-24] Everything stays in a single file
**Decision:** `f12-mcp.js` stays one ~1,500-line file; the code-standards file-split rule was overridden.
**Alternatives considered:** Split into modules (config, cdp, tools).
**Why:** Spec section 2 requires one JS file with zero dependencies, which makes it trivially copyable to an offline machine. This is an intentional override.
