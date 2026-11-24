# Project Map

- `f12-mcp-SPEC.md`: requirements (Hebrew); source of truth.
- `f12-mcp.js`: the whole MCP server (CLI, discovery, CDP connection, buffers, 7 tools, JSON-RPC loop).
- `README.md`: install, usage, tests.
- `ARCHITECTURE.md`, `DECISIONS.md`: design overview and decision log.
- `AGENT_CONTEXT.md`, `CHANGELOG.md`: session state and history.
- `test/server.js`: zero-dependency server for the local test page.
- `test/page.html`, `test/app.js`: test page and its script (console, fetch, POST, failed request, image, exception).
- `test/unit.js`: node:test unit tests.
- `test/connection.js`, `test/fake-cdp.js`, `test/cli.js`: helpers that load the main file and fake a CDP endpoint / CLI.
- `test/acceptance.js`: end-to-end spec section 10 run against headless Chrome or Edge.
