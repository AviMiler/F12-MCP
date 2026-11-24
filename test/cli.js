// test/cli.js — spawns the real f12-mcp.js process (no Chrome needed): stdin line framing, CLI exit codes, and graceful shutdown semantics. Loaded by test/unit.js; also runnable alone.
process.env.F12_MCP_NO_MAIN = '1'; // only affects this (parent) process; children are spawned with their own env
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const MCP = path.join(__dirname, '..', 'f12-mcp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childEnv = () => { const env = { ...process.env }; delete env.F12_MCP_NO_MAIN; return env; };
const deadPort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Spawns the server and collects stdout lines / stderr / exit status. */
function spawnMcp(args) {
  const child = spawn(process.execPath, [MCP, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
  const r = { child, lines: [], stderr: '', exit: null };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { r.lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { r.stderr += c; });
  child.stdin.on('error', () => {}); // the child may exit while we are still writing
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.exit = { code, signal }; res(r.exit); }));
  r.waitFor = async (pred, ms, what) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\nstdout: ${r.lines.join('|')}\nstderr: ${r.stderr}`); await sleep(10); } };
  r.kill = () => { try { child.kill(); } catch { /* already gone */ } };
  return r;
}
const withinMs = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} did not happen within ${ms} ms`); })]);

test('stdin framing: a request split across writes, CRLF, blank lines and back-to-back lines all get exactly one reply each', async () => {
  const port = await deadPort();
  const mcp = spawnMcp(['--port', String(port)]);
  try {
    await mcp.waitFor(() => mcp.stderr.includes('ready'), 5000, 'the server to report ready on stderr');
    mcp.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"pi');
    await sleep(80); // force the split across separate reads
    mcp.child.stdin.write('ng"}\r\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await mcp.waitFor(() => mcp.lines.length >= 3, 5000, 'three replies');
    await sleep(100); // nothing extra may follow
    assert.equal(mcp.lines.length, 3, mcp.lines.join('|'));
    const replies = mcp.lines.map((l) => JSON.parse(l)); // every stdout line is valid JSON
    for (const r of replies) { assert.equal(r.jsonrpc, '2.0'); assert.deepEqual(r.result, {}); }
    assert.deepEqual(replies.map((r) => r.id).sort(), [1, 2, 3]);
    assert.ok(mcp.stderr.includes('[f12-mcp]'), 'diagnostics belong on stderr with the [f12-mcp] prefix');
    mcp.child.stdin.end();
    assert.equal((await withinMs(mcp.exited, 3000, 'exit after stdin end')).code, 0);
  } finally { mcp.kill(); }
});

test('CLI exit paths: bad port and non-loopback host exit 2, --help exits 0, stdout stays empty', async () => {
  for (const [args, code] of [[['--port', 'abc'], 2], [['--host', '8.8.8.8'], 2], [['--help'], 0]]) {
    const mcp = spawnMcp(args);
    try {
      const exit = await withinMs(mcp.exited, 5000, `exit for ${args.join(' ')}`);
      assert.equal(exit.code, code, `${args.join(' ')} -> ${exit.code}\n${mcp.stderr}`);
      assert.deepEqual(mcp.lines, [], `stdout must stay empty for ${args.join(' ')}`);
      assert.match(mcp.stderr, /Usage: node f12-mcp\.js/);
    } finally { mcp.kill(); }
  }
});

test('stdin end waits for an in-flight tool call and still delivers its reply before exiting 0', async () => {
  const slow = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); }, 600));
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const mcp = spawnMcp(['--port', String(slow.address().port)]);
  try {
    await mcp.waitFor(() => mcp.stderr.includes('ready'), 5000, 'ready');
    const t0 = Date.now();
    mcp.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}\n');
    mcp.child.stdin.end(); // the client hangs up while the call is still running
    const exit = await withinMs(mcp.exited, 10000, 'exit after the in-flight call');
    assert.equal(exit.code, 0, mcp.stderr);
    assert.ok(Date.now() - t0 >= 500, 'exited before the call could finish');
    assert.equal(mcp.lines.length, 1, mcp.lines.join('|'));
    const reply = JSON.parse(mcp.lines[0]);
    assert.equal(reply.id, 1);
    assert.equal(reply.result.content[0].text, '0 page tabs open.\nNot attached (auto-attach happens when exactly one tab exists).');
  } finally { mcp.kill(); slow.closeAllConnections(); await new Promise((r) => slow.close(r)); }
});

test('stdout going away (reader closed the pipe) exits non-zero instead of hanging', async () => {
  const mcp = spawnMcp(['--port', String(await deadPort())]);
  try {
    await mcp.waitFor(() => mcp.stderr.includes('ready'), 5000, 'ready');
    mcp.child.stdout.destroy(); // simulate the host closing its read end
    for (let i = 0; i < 20 && mcp.exit === null; i++) { mcp.child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'); await sleep(100); }
    const exit = await withinMs(mcp.exited, 5000, 'exit after stdout error');
    assert.notEqual(exit.code, 0, 'a broken stdout must not look like a clean shutdown');
  } finally { mcp.kill(); }
});
