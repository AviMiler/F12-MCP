# Architecture

## System Overview
`f12-mcp.js` is an MCP server (stdio) that exposes Chrome/Edge DevTools Console and Network data to Claude Code through 7 tools. It keeps capped in-memory buffers (1000 console, 500 network) fed by CDP events from one attached tab.

## Entry Points
`node f12-mcp.js [--port 9222] [--host 127.0.0.1]`. `test/server.js` starts the local test page; `test/acceptance.js` and `test/unit.js` run the tests.

## Module Map
Everything lives in `f12-mcp.js`, in numbered sections: config/CLI, logging, utils, discovery (HTTP `/json/list`), CDP WebSocket connection, per-tab `Attachment` (event ingestion), session (single active attachment), tool rendering, MCP/JSON-RPC loop. `test/` holds the test page, server, and unit/acceptance tests plus helpers (`connection.js`, `fake-cdp.js`, `cli.js`) that load the main file.

## Data Flow
Claude call -> JSON-RPC line on stdin -> tool handler -> `ensureAttached` -> CDP commands over WebSocket; CDP events update the `Attachment` buffers. Tools render one line per item; `network_detail` fetches the body lazily. Only protocol JSON goes to stdout; logs go to stderr.

## External Integrations
Chrome/Edge remote debugging endpoint at `config.host:config.port` (HTTP `/json/list`, then the tab's `webSocketDebuggerUrl`). Nothing else; no npm packages.

## Key Boundaries & Constraints
Zero `require`/`import` (globals only; Node 22+ for global `WebSocket`) and a single file, per spec section 2. Loopback-only host and debugger URL. One active tab at a time; buffers die with the attachment. Output sizes are capped (body, url, headers, redirects) to bound tokens.

## Design Decisions
See `DECISIONS.md`.
