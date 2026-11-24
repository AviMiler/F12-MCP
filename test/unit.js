// test/unit.js — node:test unit tests for the pure/in-memory parts of f12-mcp.js (no Chrome needed).
process.env.F12_MCP_NO_MAIN = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const m = require('../f12-mcp.js');
require('./connection.js'); // WebSocket/session tests against the fake CDP server; registered into this run
require('./cli.js'); // spawned-process tests: stdin framing, CLI exit codes, shutdown

const T = (y, mo, d, h, mi, s, ms) => new Date(y, mo, d, h, mi, s, ms).getTime();

// ---------------------------------------------------------------- §1 CLI
test('parseArgs: defaults, --port N, --port=N, --host forms', () => {
  assert.deepEqual(m.parseArgs([]), { port: 9222, host: '127.0.0.1', help: false });
  assert.equal(m.parseArgs(['--port', '9333']).port, 9333);
  assert.equal(m.parseArgs(['--port=9444']).port, 9444);
  assert.equal(m.parseArgs(['--host=localhost']).host, 'localhost');
  assert.equal(m.parseArgs(['--host', '::1']).host, '::1');
  assert.equal(m.parseArgs(['--help']).help, true);
});

test('parseArgs: rejects bad ports and non-loopback hosts', () => {
  for (const bad of [['--port', '0'], ['--port', '70000'], ['--port', 'abc'], ['--port', '12.5'], ['--port']]) {
    assert.throws(() => m.parseArgs(bad), /port/i, JSON.stringify(bad));
  }
  assert.throws(() => m.parseArgs(['--host', '192.168.1.5']), /loopback/i);
  assert.throws(() => m.parseArgs(['--host=example.com']), /loopback/i);
  assert.throws(() => m.parseArgs(['--bogus']), /unknown/i);
});

test('isLoopbackHost accepts only loopback names', () => {
  for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) assert.equal(m.isLoopbackHost(h), true, h);
  for (const h of ['192.168.1.5', 'example.com', '127.0.0.1.evil.com', '0.0.0.0', '', undefined]) assert.equal(m.isLoopbackHost(h), false, String(h));
});

test('hostForUrl brackets IPv6 only', () => {
  assert.equal(m.hostForUrl('::1'), '[::1]');
  assert.equal(m.hostForUrl('[::1]'), '[::1]');
  assert.equal(m.hostForUrl('127.0.0.1'), '127.0.0.1');
});

// ---------------------------------------------------------------- §3 utils
test('fmtBytes / fmtKB / fmtMs', () => {
  assert.equal(m.fmtBytes(0), '0 B');
  assert.equal(m.fmtBytes(120), '120 B');
  assert.equal(m.fmtBytes(1536), '1.5 KB');
  assert.equal(m.fmtBytes(1048576), '1.0 MB');
  assert.equal(m.fmtKB(2048), '2.0');
  assert.equal(m.fmtMs(45), '45 ms');
  assert.equal(m.fmtMs(45.4), '45 ms');
  assert.equal(m.fmtMs(1230), '1.23 s');
  assert.equal(m.fmtMs(999.7), '1.00 s');
});

test('fmtClock renders local HH:MM:SS.mmm', () => {
  assert.equal(m.fmtClock(T(2025, 0, 15, 9, 3, 4, 7)), '09:03:04.007');
});

test('oneLine folds newlines and caps with a remaining-count marker', () => {
  assert.equal(m.oneLine('a\nb', 100), 'a ⏎ b');
  assert.equal(m.oneLine('a\r\nb', 100), 'a ⏎ b');
  assert.equal(m.oneLine('abcdefghij', 5), 'abcde…(+5 chars)');
  assert.equal(m.oneLine('abcde', 5), 'abcde');
});

test('truncateNote appends the Hebrew note only when truncating', () => {
  assert.equal(m.truncateNote('abcdef', 3), 'abc\n[נחתך, 3 תווים מתוך 6]');
  assert.equal(m.truncateNote('abc', 3), 'abc');
  assert.equal(m.truncateNote('abc', 10), 'abc');
});

test('shortUrl: same origin -> path+query, data: urls summarized, long urls capped', () => {
  const o = 'http://127.0.0.1:8765';
  assert.equal(m.shortUrl('http://127.0.0.1:8765/api/ok?x=1', o), '/api/ok?x=1');
  assert.equal(m.shortUrl('http://127.0.0.1:8765', o), '/');
  assert.equal(m.shortUrl('http://other.test:1/x', o), 'http://other.test:1/x');
  assert.equal(m.shortUrl('data:image/png;base64,AAAA', o), 'data:image/png…(26 chars)');
  const long = m.shortUrl('http://other.test/' + 'a'.repeat(300), o);
  assert.equal(long.length <= 210, true);
  assert.match(long, /…/);
});

test('fmtLoc converts 0-based line/col to 1-based and shortens the url', () => {
  const o = 'http://h:1';
  assert.equal(m.fmtLoc('http://h:1/app.js', 2, 0, o, false), '/app.js:3');
  assert.equal(m.fmtLoc('http://h:1/app.js', 11, 42, o, true), '/app.js:12:43');
  assert.equal(m.fmtLoc('', 0, 0, o, true), '<anonymous>:1:1');
});

test('parseSince: ids, epoch seconds/ms, HH:MM:SS today, ISO, and garbage', () => {
  const now = T(2025, 0, 15, 12, 0, 0, 0);
  assert.deepEqual(m.parseSince(41, now), { kind: 'id', value: 41 });
  assert.deepEqual(m.parseSince('41', now), { kind: 'id', value: 41 });
  assert.deepEqual(m.parseSince(1736935200, now), { kind: 'ts', value: 1736935200000 });
  assert.deepEqual(m.parseSince(1736935200123, now), { kind: 'ts', value: 1736935200123 });
  assert.deepEqual(m.parseSince('11:30:15.250', now), { kind: 'ts', value: T(2025, 0, 15, 11, 30, 15, 250) });
  assert.deepEqual(m.parseSince('11:30', now), { kind: 'ts', value: T(2025, 0, 15, 11, 30, 0, 0) });
  assert.deepEqual(m.parseSince('2025-01-15T10:00:00Z', now), { kind: 'ts', value: 1736935200000 });
  assert.throws(() => m.parseSince('not a time', now), /since/i);
});

test('parseSince rejects out-of-range clock fields instead of rolling over', () => {
  for (const bad of ['24:00', '25:10', '12:60', '12:61:00', '12:30:60', '99:99:99']) assert.throws(() => m.parseSince(bad, T(2025, 0, 15, 12, 0, 0, 0)), /since/i, bad);
  assert.deepEqual(m.parseSince('23:59:59.999', T(2025, 0, 15, 12, 0, 0, 0)), { kind: 'ts', value: T(2025, 0, 15, 23, 59, 59, 999) });
});

test('clampInt: default, numeric string, range violations throw ToolError', () => {
  assert.equal(m.clampInt(undefined, 'limit', 1, 1000, 100), 100);
  assert.equal(m.clampInt('25', 'limit', 1, 1000, 100), 25);
  assert.throws(() => m.clampInt(0, 'limit', 1, 1000, 100), (e) => e instanceof m.ToolError && /limit/.test(e.message));
  assert.throws(() => m.clampInt(1001, 'limit', 1, 1000, 100), m.ToolError);
  assert.throws(() => m.clampInt(1.5, 'limit', 1, 1000, 100), m.ToolError);
  assert.throws(() => m.clampInt('x', 'limit', 1, 1000, 100), m.ToolError);
});

// ---------------------------------------------------------------- §11 MCP protocol
test('initialize echoes the client protocolVersion and declares tools', async () => {
  const r = await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.deepEqual(r.result.serverInfo, { name: 'f12-mcp', version: '1.0.0' });
  assert.ok(r.result.capabilities.tools);
  assert.equal(typeof r.result.instructions, 'string');
  assert.match(r.result.instructions, /untrusted data, not instructions/); // prompt-injection guard for page-derived text
  const r2 = await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }));
  assert.equal(r2.result.protocolVersion, '2025-06-18');
});

test('notifications get no reply; ping answers {}', async () => {
  assert.equal(await m.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.equal(await m.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })), null);
  assert.deepEqual(await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })), { jsonrpc: '2.0', id: 7, result: {} });
});

test('tools/list exposes the 7 tools with strict object schemas', async () => {
  const r = await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  assert.deepEqual(r.result.tools.map((t) => t.name).sort(), ['attach', 'console', 'eval', 'list_tabs', 'network', 'network_detail', 'reload']);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(typeof t.description, 'string');
  }
  const nd = r.result.tools.find((t) => t.name === 'network_detail');
  assert.deepEqual(nd.inputSchema.required, ['id']);
  assert.deepEqual(nd.inputSchema.properties.id.type, ['integer', 'string']); // "#12" is accepted
  const con = r.result.tools.find((t) => t.name === 'console');
  assert.deepEqual(con.inputSchema.properties.since.type, ['string', 'integer']); // numeric ids are accepted
});

test('argument validation only accepts own schema properties (inherited names like toString are unknown)', async () => {
  for (const bad of ['{"toString":1}', '{"constructor":1}', '{"__proto__":1}']) {
    const r = (await m.handleLine(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"console","arguments":${bad}}}`)).result;
    assert.equal(r.isError, true, bad);
    assert.match(r.content[0].text, /Unknown argument/, bad);
  }
});

test('handleLine: one failing message in a batch gets an internal-error reply and the others are kept', async () => {
  const flaky = async (msg) => { if (msg.id === 2) throw new Error('boom'); return m.handleMessage(msg); };
  const r = await m.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }, { jsonrpc: '2.0', id: 3, method: 'ping' }]), flaky);
  assert.deepEqual(r.map((x) => x.id), [1, 2, 3]);
  assert.equal(r[1].error.code, -32603);
  assert.match(r[1].error.message, /boom/);
  assert.deepEqual(r[2].result, {});
});

test('serveLine: a rejecting handler still answers the request id; a throwing writer is retried with an error reply; notifications stay silent', async () => {
  const sent = [];
  await m.serveLine('{"jsonrpc":"2.0","id":9,"method":"ping"}', (o) => sent.push(o), async () => { throw new Error('handler exploded'); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 9);
  assert.equal(sent[0].error.code, -32603);
  const flakyWriter = []; let first = true;
  await m.serveLine('{"jsonrpc":"2.0","id":10,"method":"ping"}', (o) => { if (first) { first = false; throw new Error('cannot serialize'); } flakyWriter.push(o); });
  assert.equal(flakyWriter[0].id, 10);
  assert.equal(flakyWriter[0].error.code, -32603);
  const silent = [];
  await m.serveLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', (o) => silent.push(o), async () => { throw new Error('ignored'); });
  assert.deepEqual(silent, []); // no id to answer: nothing to send
});

test('log never throws on circular structures or BigInt and always prefixes [f12-mcp]', () => {
  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try {
    const circ = {}; circ.self = circ;
    assert.doesNotThrow(() => m.log('circular', circ, 10n, Symbol('s')));
  } finally { process.stderr.write = orig; }
  assert.equal(written.length, 1);
  assert.match(written[0], /^\[f12-mcp\] circular /);
  assert.match(written[0], /10/);
});

test('unknown method -> -32601; unknown tool -> -32602; garbage -> -32700 with null id', async () => {
  assert.equal((await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }))).error.code, -32601);
  const t = await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }));
  assert.equal(t.error.code, -32602);
  const g = await m.handleLine('{not json');
  assert.deepEqual(g, { jsonrpc: '2.0', id: null, error: { code: -32700, message: g.error.message } });
});

test('batch requests return an array of replies, skipping notifications', async () => {
  const r = await m.handleLine(JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]));
  assert.deepEqual(r.map((x) => x.id), [1, 2]);
  assert.equal((await m.handleLine('[]')).error.code, -32600);
});

// ---------------------------------------------------------------- §6 remote-object formatting
const S = (value) => ({ type: 'string', value });
const N = (value) => ({ type: 'number', value, description: String(value) });

test('fmtRemote: primitives, unserializable, null, error, preview, fallback description', () => {
  assert.equal(m.fmtRemote(S('hi')), 'hi');
  assert.equal(m.fmtRemote(N(5)), '5');
  assert.equal(m.fmtRemote({ type: 'boolean', value: false }), 'false');
  assert.equal(m.fmtRemote({ type: 'number', unserializableValue: 'NaN', description: 'NaN' }), 'NaN');
  assert.equal(m.fmtRemote({ type: 'bigint', unserializableValue: '10n', description: '10n' }), '10n');
  assert.equal(m.fmtRemote({ type: 'undefined' }), 'undefined');
  assert.equal(m.fmtRemote({ type: 'object', subtype: 'null', value: null }), 'null');
  assert.equal(m.fmtRemote({ type: 'object', subtype: 'error', description: 'TypeError: x is not a function\n    at f (a.js:1:1)' }), 'TypeError: x is not a function');
  assert.equal(m.fmtRemote({ type: 'function', description: 'function foo() {}' }), 'function foo() {}');
  assert.equal(m.fmtRemote({ type: 'object', className: 'Object', description: 'Object', objectId: '1' }), 'Object');
  const withPreview = { type: 'object', description: 'Object', preview: { type: 'object', description: 'Object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }] } };
  assert.equal(m.fmtRemote(withPreview), '{a: 1}');
});

test('fmtPreview: objects, arrays, overflow, class prefix, Map', () => {
  const props = (...kv) => kv.map(([name, type, value]) => ({ name, type, value }));
  assert.equal(m.fmtPreview({ type: 'object', description: 'Object', properties: props(['a', 'number', '1'], ['b', 'string', 'x']) }), '{a: 1, b: "x"}');
  assert.equal(m.fmtPreview({ type: 'object', subtype: 'array', description: 'Array(3)', properties: props(['0', 'number', '1'], ['1', 'number', '2'], ['2', 'number', '3']) }), '[1, 2, 3]');
  assert.equal(m.fmtPreview({ type: 'object', subtype: 'array', description: 'Array(5)', overflow: true, properties: props(['0', 'number', '1'], ['1', 'number', '2']) }), '[1, 2, …]');
  assert.equal(m.fmtPreview({ type: 'object', description: 'Object', properties: [] }), '{}');
  assert.equal(m.fmtPreview({ type: 'object', subtype: 'array', description: 'Array(0)', properties: [] }), '[]');
  assert.equal(m.fmtPreview({ type: 'object', description: 'Foo', properties: props(['a', 'number', '1']) }), 'Foo {a: 1}');
  assert.equal(m.fmtPreview({ type: 'object', subtype: 'map', description: 'Map(1)', properties: [], entries: [{ key: { type: 'string', description: 'k' }, value: { type: 'number', description: '1' } }] }), 'Map(1) {"k" => 1}');
});

test('fmtConsoleArgs: %s %d %i %f %o %c substitution, extra args, non-string first arg', () => {
  assert.equal(m.fmtConsoleArgs([S('hello %s, you are %d'), S('world'), N(5)]), 'hello world, you are 5');
  assert.equal(m.fmtConsoleArgs([S('%cstyled%c plain'), S('color:red'), S('')]), 'styled plain');
  assert.equal(m.fmtConsoleArgs([S('n=%i f=%f'), N(5.7), N(2.5)]), 'n=5 f=2.5');
  assert.equal(m.fmtConsoleArgs([S('100%% sure')]), '100% sure');
  assert.equal(m.fmtConsoleArgs([S('missing %s here')]), 'missing %s here');
  assert.equal(m.fmtConsoleArgs([S('a'), N(1), { type: 'object', description: 'Object' }]), 'a 1 Object');
  assert.equal(m.fmtConsoleArgs([N(1), S('b')]), '1 b');
  assert.equal(m.fmtConsoleArgs([]), '');
});

test('fmtFrames: 1-based loc, anonymous, async parent, "N more" cap', () => {
  const o = 'http://h:1';
  const f = (fn, line, col) => ({ functionName: fn, url: 'http://h:1/app.js', lineNumber: line, columnNumber: col });
  assert.deepEqual(m.fmtFrames({ callFrames: [f('explode', 11, 42), f('', 0, 0)] }, o), ['at explode (/app.js:12:43)', 'at (anonymous) (/app.js:1:1)']);
  assert.deepEqual(m.fmtFrames({ callFrames: [f('a', 0, 0)], parent: { description: 'setTimeout', callFrames: [f('start', 4, 1)] } }, o), ['at a (/app.js:1:1)', '-- async setTimeout --', 'at start (/app.js:5:2)']);
  assert.deepEqual(m.fmtFrames({ callFrames: [f('a', 0, 0), f('b', 1, 0), f('c', 2, 0), f('d', 3, 0)] }, o, 2), ['at a (/app.js:1:1)', 'at b (/app.js:2:1)', '… 2 more']);
  assert.deepEqual(m.fmtFrames(undefined, o), []);
});

test('stackFromDescription extracts "at" lines and shortens same-origin urls', () => {
  const d = 'Error: boom\n    at explode (http://h:1/app.js:12:43)\n    at http://h:1/app.js:20:1';
  assert.deepEqual(m.stackFromDescription(d, 'http://h:1'), ['at explode (/app.js:12:43)', 'at /app.js:20:1']);
  assert.deepEqual(m.stackFromDescription('just text', 'http://h:1'), []);
  const seven = ['Error: x'].concat([1, 2, 3, 4, 5, 6, 7].map((i) => `    at f${i} (a.js:${i}:1)`)).join('\n');
  assert.equal(m.stackFromDescription(seven, '').length, 6);
  assert.equal(m.stackFromDescription(seven, '')[5], '… 2 more');
});

// ---------------------------------------------------------------- §7 console buffer + rendering
const mkAtt = () => {
  const att = new m.Attachment({ id: 'T1', title: 'F12 Test', url: 'http://h:1/', wsUrl: 'ws://127.0.0.1:1/devtools/page/T1' }, null);
  att.attachedAt = T(2025, 0, 15, 12, 3, 1, 0);
  return att;
};
const consoleCall = (att, type, args, ts, line = 2, url = 'http://h:1/app.js') =>
  m.handleCdpEvent(att, 'Runtime.consoleAPICalled', { type, args, timestamp: ts, executionContextId: 1, stackTrace: { callFrames: [{ functionName: '', scriptId: '1', url, lineNumber: line, columnNumber: 0 }] } });
const exceptionThrown = (att, ts) => m.handleCdpEvent(att, 'Runtime.exceptionThrown', {
  timestamp: ts,
  exceptionDetails: {
    exceptionId: 1, text: 'Uncaught', lineNumber: 11, columnNumber: 42, scriptId: '1', url: 'http://h:1/app.js',
    stackTrace: { callFrames: [{ functionName: 'explode', scriptId: '1', url: 'http://h:1/app.js', lineNumber: 11, columnNumber: 42 }] },
    exception: { type: 'object', subtype: 'error', className: 'Error', description: 'Error: boom\n    at explode (http://h:1/app.js:12:43)', objectId: '9' },
  },
});
const T0 = T(2025, 0, 15, 12, 3, 4, 0);

test('console events map to levels; warning->warn, assert prefix, skip clear/endGroup', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('a')], T0);
  consoleCall(att, 'warning', [S('b')], T0);
  consoleCall(att, 'error', [S('c')], T0);
  consoleCall(att, 'assert', [S('d')], T0);
  consoleCall(att, 'debug', [S('e')], T0);
  consoleCall(att, 'info', [S('f')], T0);
  consoleCall(att, 'table', [S('g')], T0);
  consoleCall(att, 'clear', [], T0);
  consoleCall(att, 'endGroup', [], T0);
  assert.deepEqual(att.console.map((e) => [e.level, e.text]), [['log', 'a'], ['warn', 'b'], ['error', 'c'], ['error', 'Assertion failed: d'], ['debug', 'e'], ['info', 'f'], ['log', 'g']]);
});

test('renderConsole level=error lists errors and exceptions with file:line and stack, excludes warn/log', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('hello')], T0, 2);
  consoleCall(att, 'error', [S('bad thing')], T0 + 123, 4);
  exceptionThrown(att, T0 + 1000);
  const b = att.console[0].id; // ids come from a process-wide counter, so anchor on the first one
  assert.equal(m.renderConsole(att, { level: 'error' }), [
    'Console (level=error): 2 of 3 messages [tab "F12 Test"]',
    `#${b + 1} 12:03:04.123 error /app.js:5 bad thing`,
    `#${b + 2} 12:03:05.000 exception /app.js:12 Uncaught Error: boom`,
    '    at explode (/app.js:12:43)',
    `last id: ${b + 2} (pass since=${b + 2} for newer)`,
  ].join('\n'));
});

test('renderConsole level=warn includes warn+error, accepts "warning"; bad level throws', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('l')], T0);
  consoleCall(att, 'warning', [S('w')], T0);
  consoleCall(att, 'error', [S('e')], T0);
  for (const lvl of ['warn', 'warning']) {
    const out = m.renderConsole(att, { level: lvl });
    assert.match(out, /^Console \(level=warn\): 2 of 3 messages/);
    assert.ok(!out.includes(' log '));
  }
  assert.throws(() => m.renderConsole(att, { level: 'fatal' }), m.ToolError);
});

test('identical consecutive messages merge into (×N); merged entry reappears for since=<its first id>', () => {
  const att = mkAtt();
  consoleCall(att, 'error', [S('same')], T0);
  consoleCall(att, 'error', [S('same')], T0 + 1);
  consoleCall(att, 'error', [S('same')], T0 + 2);
  consoleCall(att, 'error', [S('other')], T0 + 3);
  consoleCall(att, 'error', [S('same')], T0 + 4);
  const b = att.console[0].id - 1;
  assert.deepEqual(att.console.map((e) => [e.id - b, e.lastId - b, e.count]), [[1, 3, 3], [4, 4, 1], [5, 5, 1]]);
  const out = m.renderConsole(att, { level: 'all' });
  assert.ok(out.includes(`#${b + 1} 12:03:04.000 error /app.js:3 same (×3)`), out);
  assert.ok(m.renderConsole(att, { since: b + 1 }).includes(`#${b + 1} `)); // lastId b+3 > b+1: merged entry reappears
  assert.ok(!m.renderConsole(att, { since: b + 3 }).includes(`#${b + 1} `));
});

test('same text at a different location is not merged', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('x')], T0, 1);
  consoleCall(att, 'log', [S('x')], T0, 2);
  assert.equal(att.console.length, 2);
});

test('console buffer is capped at 1000 and reports evictions', () => {
  const att = mkAtt();
  for (let i = 0; i < 1001; i++) consoleCall(att, 'log', [S(`m${i}`)], T0);
  assert.equal(att.console.length, 1000);
  assert.equal(att.consoleEvicted, 1);
  assert.equal(att.console[0].text, 'm1');
  assert.match(m.renderConsole(att, { limit: 1 }), /1 older message/);
});

test('renderConsole: limit keeps the most recent chronologically; clear empties the buffer', () => {
  const att = mkAtt();
  for (let i = 1; i <= 5; i++) consoleCall(att, 'log', [S(`m${i}`)], T0 + i);
  const out = m.renderConsole(att, { limit: 2, clear: true });
  const ids = [...out.matchAll(/^#(\d+) /gm)].map((x) => Number(x[1]));
  assert.equal(ids.length, 2);
  assert.equal(ids[1], ids[0] + 1);
  assert.match(out, /m4[\s\S]*m5/);
  assert.ok(!out.includes('m3'));
  assert.match(out, /\(console buffer cleared\)/);
  assert.equal(att.console.length, 0);
  assert.match(m.renderConsole(att, {}), /^No console messages matching level=all \(0 captured since attach at 12:03:01\)\./);
});

test('renderConsole empty result states the filter and the captured count', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('only a log')], T0);
  assert.equal(m.renderConsole(att, { level: 'error' }), 'No console messages matching level=error (1 captured since attach at 12:03:01).');
});

test('promise rejection and non-Error throws keep the Uncaught prefix; no-location exceptions render without loc', () => {
  const att = mkAtt();
  m.handleCdpEvent(att, 'Runtime.exceptionThrown', { timestamp: T0, exceptionDetails: { exceptionId: 2, text: 'Uncaught (in promise)', lineNumber: 0, columnNumber: 0, exception: { type: 'object', subtype: 'error', description: 'Error: rejected\n    at <anonymous>:1:5' } } });
  m.handleCdpEvent(att, 'Runtime.exceptionThrown', { timestamp: T0, exceptionDetails: { exceptionId: 3, text: 'Uncaught', lineNumber: 0, columnNumber: 0, url: 'http://h:1/app.js', exception: { type: 'string', value: 'plain string' } } });
  assert.equal(att.console[0].text, 'Uncaught (in promise) Error: rejected');
  assert.deepEqual(att.console[0].stack, ['at <anonymous>:1:5']);
  assert.equal(att.console[0].loc, null);
  assert.equal(att.console[1].text, 'Uncaught plain string');
  assert.equal(att.console[1].loc.line, 1);
});

test('Log.entryAdded: browser messages are kept with source tag, javascript source is skipped', () => {
  const att = mkAtt();
  m.handleCdpEvent(att, 'Log.entryAdded', { entry: { source: 'javascript', level: 'error', text: 'dup', timestamp: T0 } });
  m.handleCdpEvent(att, 'Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 500', timestamp: T0, url: 'http://h:1/api/fail' } });
  m.handleCdpEvent(att, 'Log.entryAdded', { entry: { source: 'security', level: 'warning', text: 'CSP', timestamp: T0 } });
  m.handleCdpEvent(att, 'Log.entryAdded', { entry: { source: 'other', level: 'verbose', text: 'v', timestamp: T0 } });
  assert.deepEqual(att.console.map((e) => [e.level, e.text]), [['error', '[network] Failed to load resource: 500'], ['warn', '[security] CSP'], ['debug', '[other] v']]);
  assert.equal(att.console[0].loc.url, 'http://h:1/api/fail');
});

test('main-frame navigation updates origin and adds a nav entry (no clear); subframes ignored; crash is an error entry', () => {
  const att = mkAtt();
  consoleCall(att, 'log', [S('before')], T0);
  m.handleCdpEvent(att, 'Page.frameNavigated', { frame: { id: 'F', parentId: 'P', url: 'http://sub.test/' } });
  assert.equal(att.origin, 'http://h:1');
  m.handleCdpEvent(att, 'Page.frameNavigated', { frame: { id: 'P', url: 'http://other.test:2/page' } });
  assert.equal(att.origin, 'http://other.test:2');
  assert.equal(att.target.url, 'http://other.test:2/page');
  m.handleCdpEvent(att, 'Inspector.targetCrashed', {});
  assert.deepEqual(att.console.map((e) => [e.level, e.text]), [['log', 'before'], ['nav', '--- navigated to http://other.test:2/page ---'], ['error', '[target crashed]']]);
  assert.ok(!/nav/.test(m.renderConsole(att, { level: 'error' })));
});

test('a detached attachment ignores late events', () => {
  const att = mkAtt();
  att.dead = true;
  consoleCall(att, 'log', [S('late')], T0);
  assert.equal(att.console.length, 0);
});

// ---------------------------------------------------------------- §7 network ingestion
const ORIGIN = 'http://h:1';
const ev = (att, method, params) => m.handleCdpEvent(att, method, params);
const wall = (t) => 1736935200 + t; // wallTime seconds
const reqSent = (att, id, url, o = {}) => ev(att, 'Network.requestWillBeSent', {
  requestId: id, loaderId: 'L', documentURL: `${ORIGIN}/`, timestamp: o.t ?? 100, wallTime: wall(o.t ?? 100), frameId: 'F',
  type: 'type' in o ? o.type : 'Fetch', initiator: o.initiator ?? { type: 'script' },
  request: { url, method: o.method ?? 'GET', headers: o.headers ?? { Accept: '*/*' }, postData: o.postData, hasPostData: o.hasPostData },
  redirectResponse: o.redirectResponse,
});
const respRecv = (att, id, url, status, o = {}) => ev(att, 'Network.responseReceived', {
  requestId: id, timestamp: o.t ?? 100.004, type: o.type ?? 'Fetch',
  response: {
    url, status, statusText: o.statusText ?? (status === 200 ? 'OK' : ''), headers: o.headers ?? { 'content-type': 'application/json' },
    mimeType: o.mime ?? 'application/json', protocol: 'http/1.1', remoteIPAddress: '127.0.0.1', remotePort: 8765,
    fromDiskCache: !!o.disk, fromServiceWorker: !!o.sw, fromPrefetchCache: !!o.prefetch, encodedDataLength: 0, timing: o.timing,
  },
});
const finished = (att, id, len, t = 100.008) => ev(att, 'Network.loadingFinished', { requestId: id, timestamp: t, encodedDataLength: len });
const failedReq = (att, id, text, o = {}) => ev(att, 'Network.loadingFailed', { requestId: id, timestamp: o.t ?? 100.003, type: 'Fetch', errorText: text, canceled: !!o.canceled, blockedReason: o.blockedReason, corsErrorStatus: o.cors });
const reqExtra = (att, id, headers) => ev(att, 'Network.requestWillBeSentExtraInfo', { requestId: id, associatedCookies: [], headers, connectTiming: { requestTime: 100 } });
const respExtra = (att, id, headers, o = {}) => ev(att, 'Network.responseReceivedExtraInfo', { requestId: id, blockedCookies: o.blocked ?? [], headers, statusCode: o.status ?? 200, resourceIPAddressSpace: 'Loopback' });
const lastNet = (att) => att.network[att.network.length - 1];

test('network lifecycle: request -> response -> finished populates one entry', () => {
  const att = mkAtt();
  reqSent(att, 'R1', `${ORIGIN}/api/fail`, { t: 10 });
  assert.equal(lastNet(att).state, 'pending');
  respRecv(att, 'R1', `${ORIGIN}/api/fail`, 500, { t: 10.004 });
  finished(att, 'R1', 120, 10.008);
  const e = lastNet(att);
  assert.equal(att.network.length, 1);
  assert.deepEqual([e.method, e.url, e.type, e.status, e.statusText, e.mimeType, e.protocol, e.remote, e.state, e.encodedDataLength], ['GET', `${ORIGIN}/api/fail`, 'Fetch', 500, '', 'application/json', 'http/1.1', '127.0.0.1:8765', 'finished', 120]);
  assert.equal(att.byId.get(e.id), e);
  assert.equal(att.byReqId.get('R1'), e);
});

test('type defaults to Other; ids are sequential across entries', () => {
  const att = mkAtt();
  reqSent(att, 'A', `${ORIGIN}/a`, { type: undefined });
  reqSent(att, 'B', `${ORIGIN}/b`);
  assert.equal(att.network[0].type, 'Other');
  assert.equal(att.network[1].id, att.network[0].id + 1);
});

test('ExtraInfo is paired with its request whichever side arrives first', () => {
  const att = mkAtt();
  reqExtra(att, 'X1', { Cookie: 'a=1' }); // before requestWillBeSent
  reqSent(att, 'X1', `${ORIGIN}/x1`);
  respExtra(att, 'X1', { 'set-cookie': 'b=2' }); // before responseReceived
  respRecv(att, 'X1', `${ORIGIN}/x1`, 200);
  reqSent(att, 'X2', `${ORIGIN}/x2`);
  reqExtra(att, 'X2', { Cookie: 'c=3' }); // after
  respRecv(att, 'X2', `${ORIGIN}/x2`, 200);
  respExtra(att, 'X2', { 'set-cookie': 'd=4' });
  const [x1, x2] = att.network;
  assert.deepEqual([x1.reqExtra.headers, x1.respExtra.headers], [{ Cookie: 'a=1' }, { 'set-cookie': 'b=2' }]);
  assert.deepEqual([x2.reqExtra.headers, x2.respExtra.headers], [{ Cookie: 'c=3' }, { 'set-cookie': 'd=4' }]);
  assert.equal(att.stash.size, 0); // consumed, nothing leaks
});

test('redirect keeps ONE entry with the hop archived; hop ExtraInfo lands on the right hop in either order', () => {
  const att = mkAtt();
  const redirect302 = { url: `${ORIGIN}/api/redirect`, status: 302, statusText: 'Found', headers: { Location: '/api/ok' } };
  reqSent(att, 'R', `${ORIGIN}/api/redirect`, { t: 50, initiator: { type: 'script' } });
  reqExtra(att, 'R', { Cookie: 'hop1' });
  respExtra(att, 'R', { location: '/api/ok' }, { status: 302 }); // hop-1 response extra BEFORE the redirected request
  reqExtra(att, 'R', { Cookie: 'hop2' }); // hop-2 request extra BEFORE the redirected requestWillBeSent
  reqSent(att, 'R', `${ORIGIN}/api/ok`, { t: 50.002, redirectResponse: redirect302, initiator: { type: 'other' } });
  respRecv(att, 'R', `${ORIGIN}/api/ok`, 200);
  respExtra(att, 'R', { 'x-final': '1' });
  finished(att, 'R', 70);
  assert.equal(att.network.length, 1);
  const e = att.network[0];
  assert.equal(e.url, `${ORIGIN}/api/ok`);
  assert.equal(e.status, 200);
  assert.equal(e.initiator.type, 'script'); // first initiator kept
  assert.equal(e.redirects.length, 1);
  assert.deepEqual([e.redirects[0].url, e.redirects[0].method, e.redirects[0].status, e.redirects[0].statusText, e.redirects[0].location], [`${ORIGIN}/api/redirect`, 'GET', 302, 'Found', '/api/ok']);
  assert.deepEqual(e.redirects[0].reqExtra.headers, { Cookie: 'hop1' });
  assert.deepEqual(e.redirects[0].respExtra.headers, { location: '/api/ok' });
  assert.deepEqual(e.reqExtra.headers, { Cookie: 'hop2' });
  assert.deepEqual(e.respExtra.headers, { 'x-final': '1' });
});

test('redirect: hop-1 response ExtraInfo arriving AFTER the redirected request is attached to the hop, not the final response', () => {
  const att = mkAtt();
  reqSent(att, 'R', `${ORIGIN}/a`);
  reqSent(att, 'R', `${ORIGIN}/b`, { redirectResponse: { url: `${ORIGIN}/a`, status: 301, statusText: 'Moved', headers: { location: '/b' } } });
  respExtra(att, 'R', { location: '/b' }, { status: 301 });
  respRecv(att, 'R', `${ORIGIN}/b`, 200);
  respExtra(att, 'R', { server: 'final' }, { status: 200 });
  const e = att.network[0];
  assert.deepEqual(e.redirects[0].respExtra.headers, { location: '/b' });
  assert.deepEqual(e.respExtra.headers, { server: 'final' });
});

test('network buffer is capped at 500; evicted entries leave the lookup maps and late events are ignored', () => {
  const att = mkAtt();
  for (let i = 0; i < 501; i++) reqSent(att, `Q${i}`, `${ORIGIN}/q${i}`);
  assert.equal(att.network.length, 500);
  assert.equal(att.networkEvicted, 1);
  assert.equal(att.byReqId.has('Q0'), false);
  assert.equal(att.byReqId.size, 500);
  assert.equal(att.byId.size, 500);
  finished(att, 'Q0', 5); // late event for the evicted request: no throw, no resurrection
  assert.equal(att.network.length, 500);
  assert.match(m.renderNetwork(att, { filter: 'all', limit: 1 }), /1 older request/);
});

test('events for unknown requestIds are ignored without throwing; orphan ExtraInfo stash is bounded', () => {
  const att = mkAtt();
  respRecv(att, 'NOPE', `${ORIGIN}/n`, 200);
  finished(att, 'NOPE', 1);
  failedReq(att, 'NOPE', 'net::ERR_FAILED');
  ev(att, 'Network.dataReceived', { requestId: 'NOPE', timestamp: 1, dataLength: 5, encodedDataLength: 5 });
  ev(att, 'Network.requestServedFromCache', { requestId: 'NOPE' });
  assert.equal(att.network.length, 0);
  for (let i = 0; i < 400; i++) reqExtra(att, `orphan${i}`, { a: '1' });
  assert.ok(att.stash.size <= 300, `stash size ${att.stash.size}`);
});

test('a finished requestId reused without redirectResponse starts a new entry', () => {
  const att = mkAtt();
  reqSent(att, 'U', `${ORIGIN}/one`);
  respRecv(att, 'U', `${ORIGIN}/one`, 200);
  finished(att, 'U', 1);
  reqSent(att, 'U', `${ORIGIN}/two`);
  assert.deepEqual(att.network.map((e) => e.url), [`${ORIGIN}/one`, `${ORIGIN}/two`]);
  assert.equal(att.byReqId.get('U'), att.network[1]);
  assert.equal(att.network[0].status, 200);
});

test('loadingFailed records the failure reason; CORS, canceled and blocked details are kept', () => {
  const att = mkAtt();
  reqSent(att, 'F1', 'http://127.0.0.1:53211/nothing');
  failedReq(att, 'F1', 'net::ERR_CONNECTION_REFUSED', { t: 100.003 });
  reqSent(att, 'F2', 'http://other.test/x');
  failedReq(att, 'F2', 'net::ERR_FAILED', { cors: { corsError: 'PreflightMissingAllowOriginHeader' }, blockedReason: 'inspector', canceled: true });
  const [a, b] = att.network;
  assert.equal(a.state, 'failed');
  assert.deepEqual(a.failure, { errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false, blockedReason: undefined, corsError: undefined });
  assert.deepEqual(b.failure, { errorText: 'net::ERR_FAILED', canceled: true, blockedReason: 'inspector', corsError: 'PreflightMissingAllowOriginHeader' });
});

test('cache flags and streamed data length are recorded', () => {
  const att = mkAtt();
  reqSent(att, 'C1', `${ORIGIN}/c1`);
  ev(att, 'Network.requestServedFromCache', { requestId: 'C1' });
  reqSent(att, 'C2', `${ORIGIN}/c2`);
  ev(att, 'Network.dataReceived', { requestId: 'C2', timestamp: 1, dataLength: 100, encodedDataLength: 40 });
  ev(att, 'Network.dataReceived', { requestId: 'C2', timestamp: 1, dataLength: 50, encodedDataLength: 20 });
  assert.equal(att.network[0].fromMemoryCache, true);
  assert.equal(att.network[1].dataLength, 150);
});

// ---------------------------------------------------------------- network tool rendering
test('renderNetwork: api filter default, failed_only, exact one-line formats', () => {
  const att = mkAtt();
  reqSent(att, 'a', `${ORIGIN}/api/ok`, { t: 10 }); respRecv(att, 'a', `${ORIGIN}/api/ok`, 200); finished(att, 'a', 95, 10.012);
  reqSent(att, 'b', `${ORIGIN}/api/fail`, { t: 20 }); respRecv(att, 'b', `${ORIGIN}/api/fail`, 500); finished(att, 'b', 120, 20.008);
  reqSent(att, 'c', 'http://127.0.0.1:53211/nothing', { t: 30 }); failedReq(att, 'c', 'net::ERR_CONNECTION_REFUSED', { t: 30.003 });
  reqSent(att, 'd', `${ORIGIN}/img/pixel.png`, { t: 40, type: 'Image' }); respRecv(att, 'd', `${ORIGIN}/img/pixel.png`, 200, { type: 'Image', mime: 'image/png' }); finished(att, 'd', 300, 40.001);
  reqSent(att, 'e', `${ORIGIN}/api/pending`, { t: 50 });
  const b = att.network[0].id;
  assert.equal(m.renderNetwork(att, { failed_only: true }), [
    'Network (filter=api, failed_only): 2 of 5 requests',
    `#${b + 1} GET /api/fail 500 Fetch 120 B 8 ms`,
    `#${b + 2} GET http://127.0.0.1:53211/nothing FAILED net::ERR_CONNECTION_REFUSED Fetch - 3 ms`,
  ].join('\n'));
  const api = m.renderNetwork(att, {});
  assert.ok(api.includes(`#${b} GET /api/ok 200 Fetch 95 B 12 ms`), api);
  assert.ok(api.includes(`#${b + 4} GET /api/pending pending Fetch - -`), api);
  assert.ok(!api.includes('pixel.png'));
  const all = m.renderNetwork(att, { filter: 'all' });
  assert.ok(all.includes(`#${b + 3} GET /img/pixel.png 200 Image 300 B 1 ms`), all);
});

test('renderNetwork: url_contains is case-insensitive on the full url; limit keeps most recent; bad filter throws', () => {
  const att = mkAtt();
  for (let i = 1; i <= 4; i++) { reqSent(att, `k${i}`, `${ORIGIN}/api/Item${i}`); respRecv(att, `k${i}`, `${ORIGIN}/api/Item${i}`, 200); }
  assert.match(m.renderNetwork(att, { url_contains: 'ITEM3' }), /Item3/);
  assert.ok(!m.renderNetwork(att, { url_contains: 'ITEM3' }).includes('Item2'));
  const out = m.renderNetwork(att, { limit: 2 });
  assert.ok(out.includes('Item3') && out.includes('Item4') && !out.includes('Item2'));
  assert.match(out, /^Network \(filter=api\): 2 of 4 requests/);
  assert.throws(() => m.renderNetwork(att, { filter: 'xhr' }), m.ToolError);
});

test('renderNetwork: cache labels, redirect suffix, clear, and the empty-result hint', () => {
  const att = mkAtt();
  reqSent(att, 'm', `${ORIGIN}/api/mem`); ev(att, 'Network.requestServedFromCache', { requestId: 'm' }); respRecv(att, 'm', `${ORIGIN}/api/mem`, 200); finished(att, 'm', 0);
  reqSent(att, 'd', `${ORIGIN}/api/disk`); respRecv(att, 'd', `${ORIGIN}/api/disk`, 200, { disk: true }); finished(att, 'd', 10);
  reqSent(att, 'r', `${ORIGIN}/api/redirect`);
  reqSent(att, 'r', `${ORIGIN}/api/ok`, { redirectResponse: { url: `${ORIGIN}/api/redirect`, status: 302, statusText: 'Found', headers: { Location: '/api/ok' } } });
  respRecv(att, 'r', `${ORIGIN}/api/ok`, 200); finished(att, 'r', 70);
  const out = m.renderNetwork(att, { clear: true });
  assert.match(out, /GET \/api\/mem 200 \(memory cache\) Fetch cache /);
  assert.match(out, /GET \/api\/disk 200 \(disk cache\) Fetch 10 B /);
  assert.match(out, /GET \/api\/ok 200 Fetch 70 B .* \(redirected ×1 from \/api\/redirect\)$/m);
  assert.match(out, /\(network buffer cleared\)$/);
  assert.equal(att.network.length, 0);
  assert.equal(att.byId.size, 0);
  assert.equal(m.renderNetwork(att, {}), 'No matching requests (0 captured). Requests before attach are not captured — use reload.');
});

// ---------------------------------------------------------------- network_detail
/** Fake of the CDP boundary only: records calls, answers from a table (value or Error). */
const fakeConn = (answers = {}) => {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      const a = answers[method];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error(`unexpected CDP call ${method}`);
      return typeof a === 'function' ? a(params) : a;
    },
  };
};
const attWith = (conn) => { const att = mkAtt(); att.conn = conn; att.connected = true; return att; };
const cdpErr = (message) => Object.assign(new Error(message), { code: -32000 });
const detail = (att, args) => m.renderNetworkDetail(att, args);

/** Builds the full POST scenario the acceptance test also uses. */
const postScenario = (att) => {
  reqSent(att, 'P', `${ORIGIN}/api/echo`, { t: 200, method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"name":"f12","n":42}', hasPostData: true });
  reqExtra(att, 'P', { 'Content-Type': 'application/json', 'X-Test': '1', Cookie: 'sid=abc' });
  respRecv(att, 'P', `${ORIGIN}/api/echo`, 200, { t: 200.006, headers: { 'content-type': 'application/json' }, timing: { requestTime: 200.0004, dnsStart: -1, dnsEnd: -1, connectStart: 0.5, connectEnd: 1.5, sslStart: -1, sslEnd: -1, sendStart: 1.6, sendEnd: 1.8, receiveHeadersEnd: 5.8 } });
  respExtra(att, 'P', { 'content-type': 'application/json', 'set-cookie': 'sid=new' }, { blocked: [{ blockedReasons: ['SameSiteLax'], cookie: { name: 'sid' } }] });
  finished(att, 'P', 110, 200.009);
  return lastNet(att);
};

test('network_detail on a POST shows url, raw headers, payload, body, timing and blocked cookies', async () => {
  const conn = fakeConn({ 'Network.getResponseBody': { body: '{"received":{"name":"f12","n":42},"length":21}', base64Encoded: false } });
  const att = attWith(conn);
  const e = postScenario(att);
  const out = await detail(att, { id: e.id });
  assert.ok(out.startsWith(`#${e.id} POST ${ORIGIN}/api/echo\n`), out);
  assert.match(out, /^Status: 200 OK \| type Fetch \| mime application\/json \| http\/1\.1 \| remote 127\.0\.0\.1:8765$/m);
  assert.match(out, /^Size: 110 B transferred$/m);
  assert.match(out, /^Time \(ms\): total 9 \| queue 0 \| connect 1 \| send 0 \| wait 4 \| download 3$/m);
  assert.match(out, /^Request headers \(raw\):\n {2}Content-Type: application\/json\n {2}X-Test: 1\n {2}Cookie: sid=abc$/m);
  assert.match(out, /^Response headers \(raw\):\n(.*\n)* {2}set-cookie: sid=new$/m);
  assert.match(out, /^Blocked cookies:\n {2}sid — SameSiteLax$/m);
  assert.match(out, /^Request payload \(21 chars\):\n\{"name":"f12","n":42\}$/m);
  assert.match(out, /^Response body \(application\/json, 46 chars\):\n\{"received":\{"name":"f12","n":42\},"length":21\}$/m);
  assert.deepEqual(conn.calls, [['Network.getResponseBody', { requestId: 'P' }]]); // payload came from postData: no extra call
});

test('network_detail truncates long bodies with the Hebrew note; max_body_chars=0 reports only the length', async () => {
  const conn = fakeConn({ 'Network.getResponseBody': { body: 'x'.repeat(10000), base64Encoded: false } });
  const att = attWith(conn);
  reqSent(att, 'L', `${ORIGIN}/api/long`); respRecv(att, 'L', `${ORIGIN}/api/long`, 200); finished(att, 'L', 10000);
  const id = lastNet(att).id;
  const def = await detail(att, { id });
  assert.ok(def.includes(`${'x'.repeat(4000)}\n[נחתך, 4000 תווים מתוך 10000]`));
  assert.ok(!def.includes('x'.repeat(4001)));
  assert.ok((await detail(att, { id, max_body_chars: 100 })).includes('[נחתך, 100 תווים מתוך 10000]'));
  const none = await detail(att, { id, max_body_chars: 0 });
  assert.match(none, /Response body \(application\/json, 10000 chars\)/);
  assert.ok(!none.includes('xxxx'));
  assert.equal(conn.calls.length, 1); // body fetched once, then served from the entry cache
});

test('network_detail never fetches binary bodies and prints [binary, X KB]', async () => {
  const conn = fakeConn({});
  const att = attWith(conn);
  reqSent(att, 'I', `${ORIGIN}/img/pixel.png`, { type: 'Image' }); respRecv(att, 'I', `${ORIGIN}/img/pixel.png`, 200, { type: 'Image', mime: 'image/png' }); finished(att, 'I', 1024);
  const out = await detail(att, { id: lastNet(att).id });
  assert.match(out, /^Response body \(image\/png\): \[binary, 1\.0 KB\]$/m);
  assert.deepEqual(conn.calls, []);
});

test('isBinaryEntry: by resource type and mime, svg/json/text are not binary', () => {
  const t = (type, mimeType) => m.isBinaryEntry({ type, mimeType });
  assert.equal(t('Image', 'image/png'), true);
  assert.equal(t('Fetch', 'image/webp'), true);
  assert.equal(t('Font', 'font/woff2'), true);
  assert.equal(t('Media', 'video/mp4'), true);
  assert.equal(t('Fetch', 'application/pdf'), true);
  assert.equal(t('Fetch', 'application/octet-stream'), true);
  assert.equal(t('Fetch', 'application/zip'), true);
  assert.equal(t('Fetch', 'application/gzip'), true);
  assert.equal(t('Fetch', 'application/wasm'), true);
  assert.equal(t('Fetch', 'application/x-protobuf'), true);
  assert.equal(t('Fetch', 'application/msgpack'), true);
  assert.equal(t('Image', 'image/svg+xml'), false);
  assert.equal(t('Fetch', 'application/json'), false);
  assert.equal(t('Document', 'text/html'), false);
  assert.equal(t('Script', 'application/javascript'), false);
});

test('decodeBody: base64 text decodes, NUL bytes or invalid UTF-8 are binary', () => {
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  assert.deepEqual(m.decodeBody({ body: b64('שלום'), base64Encoded: true }), { text: 'שלום' });
  assert.deepEqual(m.decodeBody({ body: 'plain', base64Encoded: false }), { text: 'plain' });
  assert.deepEqual(m.decodeBody({ body: b64([0x68, 0x00, 0x69]), base64Encoded: true }), { binary: true, size: 3 });
  assert.deepEqual(m.decodeBody({ body: b64([0xff, 0xfe, 0xfa]), base64Encoded: true }), { binary: true, size: 3 });
});

test('network_detail: undecodable text-typed body is reported as binary', async () => {
  const conn = fakeConn({ 'Network.getResponseBody': { body: Buffer.from([0xff, 0xfe, 0xfa, 0xfb]).toString('base64'), base64Encoded: true } });
  const att = attWith(conn);
  reqSent(att, 'T', `${ORIGIN}/api/t`); respRecv(att, 'T', `${ORIGIN}/api/t`, 200, { mime: 'text/plain' }); finished(att, 'T', 4);
  assert.match(await detail(att, { id: lastNet(att).id }), /^Response body \(text\/plain\): \[binary, 0\.0 KB\]$/m);
});

test('network_detail: body states for failed, pending, 204, disconnected, and evicted-from-Chrome', async () => {
  const att = attWith(fakeConn({ 'Network.getResponseBody': cdpErr('No resource with given identifier found') }));
  reqSent(att, 'f', 'http://127.0.0.1:9/x'); failedReq(att, 'f', 'net::ERR_CONNECTION_REFUSED');
  const failedId = lastNet(att).id;
  reqSent(att, 'p', `${ORIGIN}/api/p`);
  const pendingId = lastNet(att).id;
  reqSent(att, 'n', `${ORIGIN}/api/n`); respRecv(att, 'n', `${ORIGIN}/api/n`, 204, { statusText: 'No Content' }); finished(att, 'n', 0);
  const noContentId = lastNet(att).id;
  reqSent(att, 'e', `${ORIGIN}/api/e`); respRecv(att, 'e', `${ORIGIN}/api/e`, 200); finished(att, 'e', 5);
  const evictedId = lastNet(att).id;
  const failed = await detail(att, { id: failedId });
  assert.match(failed, /^Failure: net::ERR_CONNECTION_REFUSED$/m);
  assert.match(failed, /^Response body: none \(request failed\)$/m);
  assert.match(await detail(att, { id: pendingId }), /^Response body: not available yet \(still loading\)$/m);
  assert.match(await detail(att, { id: noContentId }), /^Response body: none \(status 204\)$/m);
  assert.match(await detail(att, { id: evictedId }), /Response body no longer available in Chrome's buffer \(evicted or never stored\)\. Use reload to capture it again\./);
  att.connected = false;
  att.disconnectReason = 'Chrome closed';
  assert.match(await detail(att, { id: evictedId }), /^Response body: unavailable — disconnected from tab$/m);
});

test('network_detail: a cached body is still shown after disconnect', async () => {
  const att = attWith(fakeConn({ 'Network.getResponseBody': { body: 'cached!', base64Encoded: false } }));
  reqSent(att, 'c', `${ORIGIN}/api/c`); respRecv(att, 'c', `${ORIGIN}/api/c`, 200, { mime: 'text/plain' }); finished(att, 'c', 7);
  const id = lastNet(att).id;
  await detail(att, { id });
  att.connected = false;
  assert.match(await detail(att, { id }), /^cached!$/m);
});

test('network_detail: payload falls back to Network.getRequestPostData; a failure there is reported inline', async () => {
  const ok = attWith(fakeConn({ 'Network.getRequestPostData': { postData: 'big=payload' }, 'Network.getResponseBody': { body: '{}', base64Encoded: false } }));
  reqSent(ok, 'b', `${ORIGIN}/api/b`, { method: 'POST', hasPostData: true }); respRecv(ok, 'b', `${ORIGIN}/api/b`, 200); finished(ok, 'b', 2);
  assert.match(await detail(ok, { id: lastNet(ok).id }), /^Request payload \(11 chars\):\nbig=payload$/m);
  const bad = attWith(fakeConn({ 'Network.getRequestPostData': cdpErr('No post data available for the request'), 'Network.getResponseBody': { body: '{}', base64Encoded: false } }));
  reqSent(bad, 'b', `${ORIGIN}/api/b`, { method: 'POST', hasPostData: true }); respRecv(bad, 'b', `${ORIGIN}/api/b`, 200); finished(bad, 'b', 2);
  assert.match(await detail(bad, { id: lastNet(bad).id }), /^Request payload: \(payload not available: No post data available for the request\)$/m);
});

test('network_detail: redirect chain, initiator frames, cache origin, and provisional headers', async () => {
  const att = attWith(fakeConn({ 'Network.getResponseBody': { body: '{"ok":true}', base64Encoded: false } }));
  const stack = { callFrames: [{ functionName: 'load', url: `${ORIGIN}/app.js`, lineNumber: 7, columnNumber: 4 }] };
  reqSent(att, 'R', `${ORIGIN}/api/redirect`, { initiator: { type: 'script', stack } });
  reqSent(att, 'R', `${ORIGIN}/api/ok`, { redirectResponse: { url: `${ORIGIN}/api/redirect`, status: 302, statusText: 'Found', headers: { Location: '/api/ok' } } });
  respRecv(att, 'R', `${ORIGIN}/api/ok`, 200, { disk: true, headers: { 'x-a': '1' } }); finished(att, 'R', 11);
  const out = await detail(att, { id: lastNet(att).id });
  assert.match(out, /^Redirect chain:\n {2}1\. 302 GET \/api\/redirect → Location: \/api\/ok$/m);
  assert.match(out, /^Initiator: script\n {2}at load \(\/app\.js:8:5\)$/m);
  assert.match(out, /^Served from: disk cache$/m);
  assert.match(out, /^Request headers \(provisional\):\n {2}Accept: \*\/\*$/m);
  assert.match(out, /^Response headers:\n {2}x-a: 1$/m);
});

test('network_detail: id forms, unknown id message, bad id', async () => {
  const att = attWith(fakeConn({ 'Network.getResponseBody': { body: 'b', base64Encoded: false } }));
  reqSent(att, 'z', `${ORIGIN}/api/z`); respRecv(att, 'z', `${ORIGIN}/api/z`, 200); finished(att, 'z', 1);
  const id = lastNet(att).id;
  assert.ok((await detail(att, { id: `#${id}` })).startsWith(`#${id} GET`));
  assert.ok((await detail(att, { id: String(id) })).startsWith(`#${id} GET`));
  await assert.rejects(() => detail(att, { id: 999999 }), (e) => e instanceof m.ToolError && e.message === 'No request #999999 in buffer (cleared by reload/clear, evicted (cap 500), or never captured).');
  await assert.rejects(() => detail(att, { id: 'abc' }), m.ToolError);
  await assert.rejects(() => detail(att, { id: 1.5 }), m.ToolError);
});

test('network_detail bounds its output: body cap 200000, url line 2000, 100 headers, 20 redirect lines', async () => {
  // body cap: asking for more than the cap still truncates at 200000
  const bodyAtt = attWith(fakeConn({ 'Network.getResponseBody': { body: 'z'.repeat(300000), base64Encoded: false } }));
  reqSent(bodyAtt, 'b', `${ORIGIN}/big`); respRecv(bodyAtt, 'b', `${ORIGIN}/big`, 200, { mime: 'text/plain' }); finished(bodyAtt, 'b', 300000);
  const big = await detail(bodyAtt, { id: lastNet(bodyAtt).id, max_body_chars: 1000000000 });
  assert.ok(big.endsWith('[נחתך, 200000 תווים מתוך 300000]'), big.slice(-80));
  // url + headers
  const att = attWith(fakeConn({ 'Network.getResponseBody': { body: 'x', base64Encoded: false } }));
  const headers = {};
  for (let i = 0; i < 150; i++) headers[`H${i}`] = 'v';
  reqSent(att, 'u', `${ORIGIN}/${'a'.repeat(5000)}`, { headers }); respRecv(att, 'u', `${ORIGIN}/u`, 200); finished(att, 'u', 1);
  const out = await detail(att, { id: lastNet(att).id });
  const first = out.split('\n')[0];
  assert.ok(first.length < 2100 && first.includes('…(+'), `first line is ${first.length} chars`);
  assert.equal(out.split('\n').filter((l) => /^ {2}H\d+: v$/.test(l)).length, 100);
  assert.ok(out.includes('  … 50 more headers'));
  // redirects
  const r = attWith(fakeConn({ 'Network.getResponseBody': { body: 'x', base64Encoded: false } }));
  reqSent(r, 'R', `${ORIGIN}/hop0`);
  for (let i = 1; i <= 25; i++) reqSent(r, 'R', `${ORIGIN}/hop${i}`, { redirectResponse: { url: `${ORIGIN}/hop${i - 1}`, status: 302, statusText: 'Found', headers: { Location: `/hop${i}` } } });
  respRecv(r, 'R', `${ORIGIN}/hop25`, 200); finished(r, 'R', 1);
  const chain = await detail(r, { id: lastNet(r).id });
  assert.equal(chain.split('\n').filter((l) => /^ {2}\d+\. 302 /.test(l)).length, 20);
  assert.ok(chain.includes('  … 5 more redirects'));
});

test('orphan ExtraInfo older than the TTL is dropped on the next stash write', () => {
  const att = mkAtt();
  reqExtra(att, 'stale', { a: '1' });
  att.stash.get('stale').at = Date.now() - 31000; // older than the 30 s TTL
  reqExtra(att, 'fresh', { b: '2' });
  assert.equal(att.stash.has('stale'), false);
  assert.equal(att.stash.has('fresh'), true);
});

test('Inspector.detached marks the attachment disconnected (keeping buffers) and wakes load waiters', () => {
  const att = mkAtt();
  att.connected = true;
  consoleCall(att, 'log', [S('kept')], T0);
  let woken = false;
  att.loadWaiters.add(() => { woken = true; });
  ev(att, 'Inspector.detached', { reason: 'target_closed' });
  assert.equal(att.connected, false);
  assert.equal(att.disconnectReason, 'tab detached: target_closed');
  assert.equal(woken, true);
  assert.equal(att.console.length, 1);
});

// ---------------------------------------------------------------- §4 discovery (real fetch against a local http server)
const http = require('node:http');
const deadPort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
/** Runs fn with m.config pointed at a throw-away HTTP server answering every request via `handler`. */
const withDevtoolsServer = async (handler, fn) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...m.config };
  m.config.host = '127.0.0.1';
  m.config.port = server.address().port;
  try { return await fn(server.address().port); } finally { Object.assign(m.config, saved); m.state.att = null; await new Promise((r) => server.close(r)); }
};
const sendJson = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const tab = (id, url, title = 'T', type = 'page', ws) => ({ id, type, title, url, webSocketDebuggerUrl: ws });

/** ws url on the very server answering the request (the only port a debugger url may point to). */
const ownWs = (req, id) => `ws://${req.headers.host}/devtools/page/${id}`;

test('listPageTargets keeps only page tabs, skips devtools:// pages, builds a missing ws url', async () => {
  await withDevtoolsServer((req, res) => sendJson(res, [
    tab('A1', 'http://h:1/', 'Home', 'page', ownWs(req, 'A1')),
    tab('B2', 'devtools://devtools/bundled/inspector.html', 'DevTools', 'page', ownWs(req, 'B2')),
    tab('C3', 'http://h:1/sw.js', 'sw', 'service_worker', ownWs(req, 'C3')),
    tab('D4', 'http://h:1/nows', 'NoWs', 'page', undefined),
  ]), async (port) => {
    assert.deepEqual(await m.listPageTargets(), [
      { id: 'A1', title: 'Home', url: 'http://h:1/', wsUrl: `ws://127.0.0.1:${port}/devtools/page/A1` },
      { id: 'D4', title: 'NoWs', url: 'http://h:1/nows', wsUrl: `ws://127.0.0.1:${port}/devtools/page/D4` },
    ]);
  });
});

test('listPageTargets refuses debugger urls that are non-loopback, on another port, not ws:, or outside /devtools/', async () => {
  const cases = [
    ['non-loopback host', () => 'ws://evil.example:9222/devtools/page/A1', /non-loopback/],
    ['another loopback port', () => 'ws://127.0.0.1:9/devtools/page/A1', /port/],
    ['wss scheme', (req) => `wss://${req.headers.host}/devtools/page/A1`, /ws:/],
    ['http scheme', (req) => `http://${req.headers.host}/devtools/page/A1`, /ws:/],
    ['path outside /devtools/', (req) => `ws://${req.headers.host}/admin`, /\/devtools\//],
  ];
  for (const [label, makeUrl, re] of cases) {
    await withDevtoolsServer((req, res) => sendJson(res, [tab('A1', 'http://h:1/', 'x', 'page', makeUrl(req))]), async () => {
      await assert.rejects(() => m.listPageTargets(), (e) => e instanceof m.ToolError && /Refusing/.test(e.message) && re.test(e.message), label);
    });
  }
});

test('discovery errors: unreachable Chrome, HTTP error, and non-JSON are distinct clear ToolErrors', async () => {
  const port = await deadPort();
  const saved = { ...m.config };
  m.config.port = port;
  try {
    await assert.rejects(() => m.listPageTargets(), (e) => e instanceof m.ToolError && e.message === `Cannot reach Chrome at 127.0.0.1:${port} (ECONNREFUSED). Start Chrome with: chrome.exe --remote-debugging-port=${port} --user-data-dir=C:\\chrome-debug`);
  } finally { Object.assign(m.config, saved); }
  await withDevtoolsServer((req, res) => { res.writeHead(500); res.end('boom'); }, async () => {
    await assert.rejects(() => m.listPageTargets(), /not a DevTools endpoint/);
  });
  await withDevtoolsServer((req, res) => { res.writeHead(200); res.end('<html>hi</html>'); }, async () => {
    await assert.rejects(() => m.listPageTargets(), /not a DevTools endpoint/);
  });
  await withDevtoolsServer((req, res) => { res.writeHead(302, { Location: 'http://evil.example/' }); res.end(); }, async () => {
    await assert.rejects(() => m.listPageTargets(), m.ToolError); // redirects are never followed
  });
});

// ---------------------------------------------------------------- §8 tab resolution + session
const tg = (id, url, title = 'T') => ({ id, url, title, wsUrl: `ws://127.0.0.1:1/devtools/page/${id}` });

test('resolveTab: exact id (case-insensitive) wins over URL substring; URL substring is case-insensitive', () => {
  const targets = [tg('ABC123', 'http://h:1/app'), tg('XYZ', 'http://h:1/abc123-page'), tg('Q', 'http://other.test/Dashboard')];
  assert.equal(m.resolveTab(targets, 'abc123').id, 'ABC123'); // id beats the URL that also contains it
  assert.equal(m.resolveTab(targets, 'dashboard').id, 'Q');
});

test('resolveTab: no match lists open tabs; multiple matches list the candidates', () => {
  const targets = [tg('A', 'http://127.0.0.1:1/x', 'One'), tg('B', 'http://127.0.0.1:1/y', 'Two')];
  assert.throws(() => m.resolveTab(targets, 'nothing'), (e) => e instanceof m.ToolError && /No tab matches "nothing"\. Open tabs:/.test(e.message) && e.message.includes('A') && e.message.includes('Two'));
  assert.throws(() => m.resolveTab(targets, '127.0.0.1'), (e) => e instanceof m.ToolError && /^2 tabs match "127\.0\.0\.1"/.test(e.message) && e.message.includes('http://127.0.0.1:1/x') && e.message.includes('http://127.0.0.1:1/y'));
});

test('list_tabs marks the attached tab, never attaches, and explains the unattached state', async () => {
  await withDevtoolsServer((req, res) => sendJson(res, [tab('A1', 'http://h:1/', 'Home', 'page', ownWs(req, 'A1')), tab('B2', 'http://h:1/other', 'Other', 'page', ownWs(req, 'B2'))]), async () => {
    const before = await m.toolListTabs({});
    assert.equal(before, '2 page tabs (* = attached):\n  A1  Home — http://h:1/\n  B2  Other — http://h:1/other\nNot attached (auto-attach happens when exactly one tab exists).');
    assert.equal(m.state.att, null);
    const att = attWith(fakeConn());
    att.target.id = 'B2';
    m.state.att = att;
    const after = await m.toolListTabs({});
    assert.match(after, /^ {2}A1 {2}Home/m);
    assert.match(after, /^\* B2 {2}Other/m);
  });
});

test('ensureAttached: connected -> as is; disconnected + read -> data with a banner; live/unreachable -> clear error', async () => {
  const att = attWith(fakeConn());
  m.state.att = att;
  assert.deepEqual(await m.ensureAttached('read'), { att, notes: [] });
  att.connected = false;
  att.markDisconnected('closed (code 1006)');
  const r = await m.ensureAttached('read');
  assert.equal(r.att, att);
  assert.match(r.notes[0], /^⚠ Disconnected from tab \(closed \(code 1006\)\) at \d\d:\d\d:\d\d\. Showing data captured before disconnect\. Call attach to reconnect\.$/);
  const port = await deadPort();
  const saved = { ...m.config };
  m.config.port = port;
  try { await assert.rejects(() => m.ensureAttached('live'), /Cannot reach Chrome at 127\.0\.0\.1:/); } finally { Object.assign(m.config, saved); m.state.att = null; }
});

test('ensureAttached with several tabs and no attachment asks which one; with none says so', async () => {
  await withDevtoolsServer((req, res) => sendJson(res, [tab('A1', 'http://h:1/', 'Home', 'page', ownWs(req, 'A1')), tab('B2', 'http://h:1/o', 'Other', 'page', ownWs(req, 'B2'))]), async () => {
    await assert.rejects(() => m.ensureAttached('read'), (e) => /^Not attached; 2 tabs open — call attach with an id or URL fragment:\n/.test(e.message) && e.message.includes('A1') && e.message.includes('B2'));
  });
  await withDevtoolsServer((req, res) => sendJson(res, []), async () => {
    await assert.rejects(() => m.ensureAttached('read'), /No page tabs open/);
  });
});

// ---------------------------------------------------------------- tool wiring through the MCP layer (state injected, CDP faked)
const callTool = async (name, args) => (await m.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))).result;

test('tools/call: console and network read from the attached state; bad arguments are isError results, not protocol errors', async () => {
  const att = attWith(fakeConn());
  m.state.att = att;
  try {
    consoleCall(att, 'error', [S('wired')], T0);
    reqSent(att, 'w', `${ORIGIN}/api/w`); respRecv(att, 'w', `${ORIGIN}/api/w`, 200); finished(att, 'w', 3);
    const c = await callTool('console', { level: 'error' });
    assert.equal(c.isError, undefined);
    assert.match(c.content[0].text, /^Console \(level=error\): 1 of 1 messages/);
    assert.match((await callTool('network', {})).content[0].text, /GET \/api\/w 200 Fetch 3 B/);
    for (const [name, args] of [['console', { level: 'fatal' }], ['network', { filter: 'xhr' }], ['network_detail', { id: 'abc' }], ['network_detail', {}], ['eval', { expression: '' }], ['console', { bogus: 1 }], ['reload', { ignore_cache: 'maybe' }]]) {
      const r = await callTool(name, args);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(typeof r.content[0].text, 'string');
    }
  } finally { m.state.att = null; }
});

test('tool calls run strictly one at a time, in arrival order', async () => {
  const order = [];
  const att = attWith({ send: async (method, params) => { if (method !== 'Runtime.evaluate') return {}; order.push(`start ${params.expression}`); await new Promise((r) => setTimeout(r, 30)); order.push(`end ${params.expression}`); return { result: { type: 'string', value: params.expression } }; } });
  m.state.att = att;
  try {
    await Promise.all([callTool('eval', { expression: 'first' }), callTool('eval', { expression: 'second' })]);
  } finally { m.state.att = null; }
  assert.deepEqual(order, ['start first', 'end first', 'start second', 'end second']);
});

// ---------------------------------------------------------------- eval
const evalWith = (answers, expr = '1+1') => { const conn = fakeConn(answers); const att = attWith(conn); return m.evalInPage(att, expr).then((text) => ({ text, conn }), (error) => ({ error, conn })); };
const evalResult = (result) => ({ 'Runtime.evaluate': { result }, 'Runtime.releaseObjectGroup': {} });
const OBJ = { type: 'object', className: 'Object', description: 'Object', objectId: 'o1' };
const ARR = { type: 'object', subtype: 'array', className: 'Array', description: 'Array(2)', objectId: 'o2' };
const callsTo = (conn, method) => conn.calls.filter((c) => c[0] === method);
const byValueAnswer = (value) => ({ ...evalResult(OBJ), 'Runtime.callFunctionOn': { result: { type: 'object', value } } });

test('eval evaluates by reference exactly once, then always releases the object group', async () => {
  const { conn } = await evalWith(evalResult({ type: 'number', value: 2, description: '2' }));
  assert.deepEqual(conn.calls, [
    ['Runtime.evaluate', { expression: '1+1', returnByValue: false, generatePreview: true, awaitPromise: true, includeCommandLineAPI: true, userGesture: true, objectGroup: 'f12-eval' }],
    ['Runtime.releaseObjectGroup', { objectGroup: 'f12-eval' }],
  ]);
});

test('eval objects and arrays are serialized from the existing remote object (no second evaluation)', async () => {
  const plain = await evalWith(byValueAnswer({ a: 1, b: [1, 2] }));
  assert.equal(plain.text, '{"a":1,"b":[1,2]}');
  assert.equal(callsTo(plain.conn, 'Runtime.evaluate').length, 1);
  assert.deepEqual(callsTo(plain.conn, 'Runtime.callFunctionOn'), [['Runtime.callFunctionOn', { objectId: 'o1', functionDeclaration: 'function(){return this}', returnByValue: true }]]);
  const arr = await evalWith({ ...evalResult(ARR), 'Runtime.callFunctionOn': { result: { type: 'object', value: [1, 2] } } });
  assert.equal(arr.text, '[1,2]');
});

test('eval of an empty object adds a hint, because objects without own enumerable properties serialize as {}', async () => {
  const empty = await evalWith(byValueAnswer({}));
  assert.match(empty.text, /^\{\}\n\(note: objects without own enumerable properties serialize as \{\}/);
  assert.equal((await evalWith({ ...evalResult(ARR), 'Runtime.callFunctionOn': { result: { type: 'object', value: [] } } })).text, '[]');
});

test('eval DOM nodes, regexps and dates are described (never serialized to a misleading {})', async () => {
  const node = await evalWith(evalResult({ type: 'object', subtype: 'node', className: 'HTMLBodyElement', description: 'body', objectId: 'n1', preview: { type: 'object', subtype: 'node', description: 'body', overflow: false, properties: [] } }));
  assert.equal(node.text, 'body');
  assert.equal(callsTo(node.conn, 'Runtime.callFunctionOn').length, 0);
  assert.equal((await evalWith(evalResult({ type: 'object', subtype: 'regexp', className: 'RegExp', description: '/a+/g', objectId: 'r1' }))).text, '/a+/g');
  const map = await evalWith(evalResult({ type: 'object', subtype: 'map', className: 'Map', description: 'Map(1)', objectId: 'm1', preview: { type: 'object', subtype: 'map', description: 'Map(1)', overflow: false, properties: [], entries: [{ key: { type: 'string', description: 'k' }, value: { type: 'number', description: '1' } }] } }));
  assert.equal(map.text, 'Map(1) {"k" => 1}');
});

test('eval: when the object cannot be serialized (window, cycles) the preview is shown; the expression still ran once', async () => {
  const win = { type: 'object', className: 'Window', description: 'Window', objectId: 'w1' };
  for (const failure of [new m.CdpError('Object reference chain is too long', -32000), new m.CdpError("Object couldn't be returned by value", -32000)]) {
    const { text, conn } = await evalWith({ ...evalResult(win), 'Runtime.callFunctionOn': failure }, 'window');
    assert.equal(text, 'Window');
    assert.equal(callsTo(conn, 'Runtime.evaluate').length, 1);
    assert.deepEqual(conn.calls[conn.calls.length - 1], ['Runtime.releaseObjectGroup', { objectGroup: 'f12-eval' }]);
  }
  const viaException = await evalWith({ ...evalResult(win), 'Runtime.callFunctionOn': { result: {}, exceptionDetails: { exceptionId: 1, text: 'Uncaught' } } }, 'window');
  assert.equal(viaException.text, 'Window');
});

test('eval: a non by-value failure while serializing propagates (and the group is still released)', async () => {
  const { error, conn } = await evalWith({ ...evalResult(OBJ), 'Runtime.callFunctionOn': new m.CdpError('Cannot find context with specified id', -32000) });
  assert.match(error.message, /Cannot find context/);
  assert.equal(callsTo(conn, 'Runtime.releaseObjectGroup').length, 1);
});

test('eval result rendering: numbers, strings raw, undefined, null, NaN, functions', async () => {
  const cases = [
    [{ type: 'number', value: 2, description: '2' }, '2'],
    [{ type: 'string', value: 'hi there' }, 'hi there'],
    [{ type: 'boolean', value: false }, 'false'],
    [{ type: 'undefined' }, 'undefined'],
    [{ type: 'object', subtype: 'null', value: null }, 'null'],
    [{ type: 'number', unserializableValue: 'NaN', description: 'NaN' }, 'NaN'],
    [{ type: 'bigint', unserializableValue: '10n', description: '10n' }, '10n'],
    [{ type: 'function', className: 'Function', description: 'function f() {}' }, 'function f() {}'],
  ];
  for (const [remote, expected] of cases) assert.equal((await evalWith(evalResult(remote))).text, expected, JSON.stringify(remote));
});

test('eval exceptions (sync throw and rejected promise) become tool errors with "Uncaught" and a short stack', async () => {
  const sync = await evalWith({ 'Runtime.evaluate': { result: { type: 'object', subtype: 'error', description: 'Error: nope' }, exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 6, exception: { type: 'object', subtype: 'error', description: 'Error: nope\n    at <anonymous>:1:7\n    at b (<anonymous>:2:1)' } } } }, 'throw new Error("nope")');
  assert.ok(sync.error instanceof m.ToolError);
  assert.equal(sync.error.message, 'Uncaught Error: nope\n    at <anonymous>:1:7\n    at b (<anonymous>:2:1)');
  const rejected = await evalWith({ 'Runtime.evaluate': { result: { type: 'object', subtype: 'error' }, exceptionDetails: { exceptionId: 2, text: 'Uncaught (in promise)', lineNumber: 0, columnNumber: 0, exception: { type: 'object', subtype: 'error', description: 'Error: nope' } } } });
  assert.equal(rejected.error.message, 'Uncaught (in promise) Error: nope');
  const str = await evalWith({ 'Runtime.evaluate': { result: { type: 'string', value: 'plain' }, exceptionDetails: { exceptionId: 3, text: 'Uncaught (in promise)', lineNumber: 0, columnNumber: 0, exception: { type: 'string', value: 'plain' } } } });
  assert.equal(str.error.message, 'Uncaught (in promise) plain');
  assert.equal(callsTo(str.conn, 'Runtime.releaseObjectGroup').length, 1); // released even when the page threw
});

test('eval: other CDP errors propagate; huge output is capped with the Hebrew note', async () => {
  const bad = await evalWith({ 'Runtime.evaluate': new m.CdpError('Cannot find context with specified id', -32000) });
  assert.match(bad.error.message, /Cannot find context/);
  const big = await evalWith(evalResult({ type: 'string', value: 'y'.repeat(30000) }));
  assert.ok(big.text.endsWith('\n[נחתך, 20000 תווים מתוך 30000]'));
  assert.equal(big.text.length, 20000 + '\n[נחתך, 20000 תווים מתוך 30000]'.length);
});

// ---------------------------------------------------------------- reload
test('reload: old buffers are cleared only after Page.reload succeeds, events that raced the reply are kept, and the summary reflects the new page', async () => {
  const att = mkAtt();
  att.connected = true;
  att.pageEnabled = true;
  consoleCall(att, 'log', [S('old')], T0);
  reqSent(att, 'old', `${ORIGIN}/old`);
  let seenAtReload;
  att.conn = fakeConn({
    'Page.reload': (params) => {
      seenAtReload = { params, console: att.console.length, network: att.network.length };
      consoleCall(att, 'log', [S('fresh')], T0); // the new page's first events can arrive before the command reply
      reqSent(att, 'n1', `${ORIGIN}/api/one`);
      setTimeout(() => {
        reqSent(att, 'n2', `${ORIGIN}/img/x.png`, { type: 'Image' });
        ev(att, 'Page.loadEventFired', { timestamp: 1 });
      }, 30);
      return {};
    },
  });
  m.state.att = att;
  try {
    const out = await m.toolReload({ ignore_cache: true });
    assert.deepEqual(seenAtReload, { params: { ignoreCache: true }, console: 1, network: 1 }); // nothing was cleared before the send
    assert.match(out, /^Reloaded \(ignore_cache=true\)\. Buffers cleared\. Load event after \d+ ms\. Captured so far: 1 console messages, 2 requests \(1 api\)\.$/);
    assert.deepEqual(att.console.map((e) => e.text), ['fresh']);
    assert.deepEqual(att.network.map((e) => e.url), [`${ORIGIN}/api/one`, `${ORIGIN}/img/x.png`]);
  } finally { m.state.att = null; }
});

test('reload: when Page.reload fails the existing buffers are untouched', async () => {
  const att = mkAtt();
  att.connected = true;
  att.pageEnabled = true;
  consoleCall(att, 'log', [S('precious')], T0);
  reqSent(att, 'keep', `${ORIGIN}/keep`);
  att.conn = fakeConn({ 'Page.reload': new m.CdpError('Cannot reload this page', -32000) });
  m.state.att = att;
  try {
    await assert.rejects(() => m.toolReload({}), /Cannot reload this page/);
    assert.deepEqual(att.console.map((e) => e.text), ['precious']);
    assert.deepEqual(att.network.map((e) => e.url), [`${ORIGIN}/keep`]);
  } finally { m.state.att = null; }
});

test('reload: a load event from the old page (arriving before the reload reply) does not end the wait early', async () => {
  const att = mkAtt();
  att.connected = true;
  att.pageEnabled = true;
  att.conn = fakeConn({
    'Page.reload': () => {
      ev(att, 'Page.loadEventFired', { timestamp: 1 }); // stale: belongs to the page being replaced
      setTimeout(() => ev(att, 'Page.loadEventFired', { timestamp: 2 }), 120);
      return {};
    },
  });
  m.state.att = att;
  try {
    const out = await m.toolReload({});
    const ms = Number(/Load event after (\d+) ms/.exec(out)[1]);
    assert.ok(ms >= 100, `waited only ${ms} ms: the stale event woke the waiter`);
  } finally { m.state.att = null; }
});

test('a connection lost mid-call is reported as "Cannot reach Chrome" when Chrome is down, or as a reconnect hint when it is up', async () => {
  const lost = () => attWith({ send: async () => { throw new m.ConnectionLostError('Connection to Chrome closed while waiting for Runtime.evaluate'); } });
  const port = await deadPort();
  const saved = { ...m.config };
  m.config.port = port;
  m.state.att = lost();
  try {
    await assert.rejects(() => m.toolEval({ expression: '1+1' }), /Cannot reach Chrome at 127\.0\.0\.1:/);
    m.state.att = lost();
    await assert.rejects(() => m.toolReload({}), /Cannot reach Chrome at 127\.0\.0\.1:/);
  } finally { Object.assign(m.config, saved); m.state.att = null; }
  await withDevtoolsServer((req, res) => sendJson(res, []), async () => {
    m.state.att = lost();
    await assert.rejects(() => m.toolEval({ expression: '1+1' }), (e) => e instanceof m.ToolError && /closed while waiting for Runtime\.evaluate.*call attach to reconnect/s.test(e.message));
  });
});

test('reload reports (not errors) a missing load event, and errors if the tab disconnects meanwhile', async () => {
  const noLoad = mkAtt();
  noLoad.connected = true;
  noLoad.pageEnabled = false; // short wait when Page events are unavailable
  noLoad.conn = fakeConn({ 'Page.reload': {} });
  m.state.att = noLoad;
  try {
    const out = await m.toolReload({});
    assert.match(out, /^Reloaded \(ignore_cache=false\)\. Buffers cleared\. Load event not seen within 1\.50 s\./);
  } finally { m.state.att = null; }
  const dropped = mkAtt();
  dropped.connected = true;
  dropped.pageEnabled = true;
  dropped.conn = fakeConn({ 'Page.reload': () => { setTimeout(() => dropped.markDisconnected('closed (code 1006)'), 10); return {}; } });
  await withDevtoolsServer((req, res) => sendJson(res, []), async () => {
    m.state.att = dropped; // Chrome itself is still up here, so the original reason is reported with a reconnect hint
    await assert.rejects(() => m.toolReload({}), /Disconnected from tab \(closed \(code 1006\)\) during reload\. Chrome is still reachable; call attach to reconnect/);
  });
});
