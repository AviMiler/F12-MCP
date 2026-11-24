# f12-mcp

A small MCP server that gives Claude Code the **Console** and **Network** panels of Chrome/Edge DevTools (F12), for working offline. One JS file, zero dependencies, MCP (newline-delimited JSON-RPC) hand-rolled over stdio, CDP over WebSocket to a local debug port. Full requirements: `f12-mcp-SPEC.md` (Hebrew).

## Requirements
- Node.js 22+ (uses the built-in global `WebSocket`; check with `node -v`).
- Chrome or Edge started with a debug port and a **separate profile**:

```
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug
```

The debug port gives full control of the browser; never use your personal profile. The server connects to loopback only (`--host` accepts 127.0.0.1, localhost or ::1).

## Install
```
claude mcp add f12 -- node "C:\path\to\f12-mcp.js" --port 9222
claude mcp list
```
Flags: `--port` (default 9222), `--host` (default 127.0.0.1). Optionally add `"mcp__f12"` to `allow` in `~/.claude/settings.json`.

## Tools
- `list_tabs`: id, title and URL of each page tab, and which one is attached.
- `attach`: connect to a tab (id or part of its URL); auto-picks the only page tab.
- `console`: console messages and exceptions (`level`, `since`, `limit`, `clear`), one line each.
- `network`: one line per request (`filter`, `failed_only`, `url_contains`, `limit`, `clear`).
- `network_detail`: headers, payload, response body (truncated by `max_body_chars`), initiator, timing for one request.
- `eval`: run JavaScript in the page and return the result or error.
- `reload`: reload the page (`ignore_cache`) and clear buffers to capture from the start.

Events from before `attach` are not visible (as in F12); use `reload`.

## Tests
```
node --test test/unit.js        # unit tests (fake CDP)
node test/acceptance.js         # end-to-end spec section 10 against headless Chrome/Edge
```
Acceptance options: `CHROME_PATH` to choose the browser binary, `HEADED=1` to show the window. `test/server.js` + `page.html` + `app.js` are the local test page and its zero-dependency server.
