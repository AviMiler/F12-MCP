# Agent Context

## Project
f12-mcp: zero-dependency MCP server giving Claude Code Chrome/Edge DevTools Console and Network. Spec: `f12-mcp-SPEC.md` (Hebrew). Docs: `README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `PROJECT_MAP.md`. Not a git repo.

## Status
Phase 1 (spec sections 1-10) is built and verified. Phase 2 (spec section 11) is not started.

## Standing Facts
- One file `f12-mcp.js`, no require/import, Node 22+ (global WebSocket). Single file is intentional (spec section 2).
- Loopback only; one attached tab at a time.
- Tests: `node --test test/unit.js` and `node test/acceptance.js` (`CHROME_PATH`, `HEADED=1`).
- Chrome 158 and Edge connect without `--remote-allow-origins`.

## Last Changes
- 2026-11-24: Phase 1 built and verified; docs written.

## Next Steps
- Per-entry ingest caps on text, postData and headers (bound memory from a hostile page).
- Size cap on the discovery response.
- Replayed console objects have no previews when attaching without a reload.
- No top-level await in eval.
- Dropped-event counter when an event handler throws; note when Page.enable fails.
- CRLF framing test does not discriminate; fix it.
- Phase 2 per spec section 11 (WebSocket frames, Workers, HAR export, start-chrome.ps1).
