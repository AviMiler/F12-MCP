// test/connection.js — tests for f12-mcp's WebSocket connection and attach/reconnect session logic against a fake CDP server (test/fake-cdp.js). Loaded by test/unit.js; also runnable alone.
process.env.F12_MCP_NO_MAIN = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const m = require('../f12-mcp.js');
const { startFakeChrome, NO_REPLY, Fail } = require('./fake-cdp.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitUntil timed out'); await sleep(10); } };
const TAB1 = { id: 'T1', title: 'One', url: 'http://h:1/one' };
const TAB2 = { id: 'T2', title: 'Two', url: 'http://h:1/two' };
const logCall = (text) => ({ type: 'log', args: [{ type: 'string', value: text }], timestamp: 1736935200000, executionContextId: 1 });

/** Runs fn against a fake Chrome with m.config pointed at it; always detaches and closes afterwards. */
async function withChrome(opts, fn) {
  const chrome = await startFakeChrome(opts);
  const saved = { ...m.config };
  m.config.host = '127.0.0.1';
  m.config.port = chrome.port;
  m.state.att = null;
  try { return await fn(chrome); } finally {
    Object.assign(m.config, saved);
    if (m.state.att) { m.state.att.dead = true; m.state.att.conn.onClose = null; m.state.att.conn.close(); m.state.att = null; }
    await chrome.close();
  }
}
/** Runs fn() while collecting everything written to stderr; {done: Promise, text(): string}. */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  const done = Promise.resolve().then(fn).finally(() => { process.stderr.write = orig; });
  return { done, text: () => chunks.join('') };
}
const deadWsPort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const open = (chrome, id = 'T1') => m.CdpConnection.open(`ws://127.0.0.1:${chrome.port}/devtools/page/${id}`);

// ---------------------------------------------------------------- CdpConnection
test('send correlates replies by id even when they arrive out of order', async () => {
  await withChrome({ tabs: [TAB1], handler: async ({ method }) => { if (method === 'A.slow') await sleep(60); return { tag: method }; } }, async (chrome) => {
    const conn = await open(chrome);
    const [slow, fast] = await Promise.all([conn.send('A.slow'), conn.send('A.fast')]);
    assert.deepEqual([slow, fast], [{ tag: 'A.slow' }, { tag: 'A.fast' }]);
    conn.close();
  });
});

test('a protocol error reply rejects with CdpError carrying the CDP code', async () => {
  await withChrome({ tabs: [TAB1], handler: () => { throw new Fail("'X.y' wasn't found", -32601); } }, async (chrome) => {
    const conn = await open(chrome);
    await assert.rejects(() => conn.send('X.y'), (e) => e instanceof m.CdpError && e.code === -32601 && /wasn't found/.test(e.message));
    conn.close();
  });
});

test('an unanswered command times out (debugger hint for evaluate) and its late reply is ignored', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withChrome({ tabs: [TAB1], handler: async ({ method }) => { if (method === 'Slow' || method === 'Runtime.evaluate') { await gate; return { late: true }; } return { ok: true }; } }, async (chrome) => {
    const conn = await open(chrome);
    await assert.rejects(() => conn.send('Slow', {}, 50), /CDP Slow timed out after 0\.05s$/);
    await assert.rejects(() => conn.send('Runtime.evaluate', {}, 50), /page may be paused in debugger/);
    release();
    await sleep(30);
    assert.deepEqual(await conn.send('Fast'), { ok: true }); // the connection is still healthy after the late replies
    assert.equal(conn.pending.size, 0);
    conn.close();
  });
});

test('events reach onEvent; a throwing handler or a garbage frame does not break the connection', async () => {
  await withChrome({ tabs: [TAB1], handler: ({ method }, client) => { if (method === 'Go') { client.emit('X.one', { n: 1 }); client.sendRaw('not json'); client.emit('X.two', { n: 2 }); } return {}; } }, async (chrome) => {
    const conn = await open(chrome);
    const seen = [];
    conn.onEvent = (method, params) => { seen.push([method, params.n]); if (method === 'X.one') throw new Error('handler bug'); };
    const logged = captureStderr(() => conn.send('Go').then(() => waitUntil(() => seen.length === 2)));
    await logged.done;
    assert.deepEqual(seen, [['X.one', 1], ['X.two', 2]]);
    assert.ok(logged.text().includes('[f12-mcp] malformed CDP frame ignored: not json'), logged.text()); // dropped frames are visible in the log
    assert.ok(logged.text().includes('handler bug'));
    assert.deepEqual(await conn.send('Still'), {});
    conn.close();
  });
});

test('a dropped socket rejects in-flight commands, fires onClose once, and later sends fail as ConnectionLostError', async () => {
  await withChrome({ tabs: [TAB1], handler: () => NO_REPLY }, async (chrome) => {
    const conn = await open(chrome);
    const reasons = [];
    conn.onClose = (r) => reasons.push(r);
    const inflight = conn.send('Slow', {}, 60000); // long on purpose: only the close path may settle it within a second
    setTimeout(() => chrome.clients[0].destroy(), 20);
    const watchdog = sleep(1000).then(() => { throw new Error('in-flight command was not rejected within 1 s of the socket dropping'); });
    await Promise.race([assert.rejects(inflight, (e) => e instanceof m.ConnectionLostError && e.message === 'Connection to Chrome closed while waiting for Slow'), watchdog]);
    assert.equal(conn.closed, true);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /^closed \(code \d+/);
    await assert.rejects(() => conn.send('After'), (e) => e instanceof m.ConnectionLostError && /^Not connected to tab \(closed/.test(e.message));
    conn.close(); // idempotent: must not fire onClose again
    assert.equal(reasons.length, 1);
  });
});

test('open() on a dead port fails with a message that mentions --remote-allow-origins', async () => {
  const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  await assert.rejects(() => m.CdpConnection.open(`ws://127.0.0.1:${port}/devtools/page/X`), (e) => e instanceof m.ToolError && /--remote-allow-origins=\*/.test(e.message));
});

// ---------------------------------------------------------------- session: attach / replay / reconnect
test('attachTo captures the Runtime.enable replay and enables console, log, network (enlarged buffers) and page domains', async () => {
  await withChrome({ tabs: [TAB1], handler: ({ method }, client) => { if (method === 'Runtime.enable') client.emit('Runtime.consoleAPICalled', logCall('replayed')); return {}; } }, async (chrome) => {
    const { att, already } = await m.attachTo({ ...TAB1, wsUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/T1` });
    assert.equal(already, false);
    assert.deepEqual(att.console.map((e) => e.text), ['replayed']); // events were wired before the enables
    assert.equal(att.connected, true);
    assert.equal(att.pageEnabled, true);
    const methods = chrome.commands.map((c) => c.method).sort();
    assert.deepEqual(methods, ['Log.enable', 'Network.enable', 'Page.enable', 'Runtime.enable']);
    const net = chrome.commands.find((c) => c.method === 'Network.enable').params;
    assert.ok(net.maxTotalBufferSize >= 100 * 1024 * 1024 && net.maxResourceBufferSize >= 10 * 1024 * 1024, JSON.stringify(net));
  });
});

test('a rejected Page.enable is tolerated; a rejected Runtime.enable aborts the attach and closes the socket', async () => {
  await withChrome({ tabs: [TAB1], handler: ({ method }) => { if (method === 'Page.enable') throw new Fail('Page domain not available'); return {}; } }, async (chrome) => {
    const { att } = await m.attachTo({ ...TAB1, wsUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/T1` });
    assert.equal(att.pageEnabled, false);
    assert.equal(att.connected, true);
  });
  await withChrome({ tabs: [TAB1], handler: ({ method }) => { if (method === 'Runtime.enable') throw new Fail('no runtime'); return {}; } }, async (chrome) => {
    await assert.rejects(() => m.attachTo({ ...TAB1, wsUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/T1` }), /no runtime/);
    assert.equal(m.state.att, null);
    await waitUntil(() => chrome.clients[0].closed);
  });
});

test('re-attaching the same tab keeps buffers; attaching another tab drops the first (dead, socket closed)', async () => {
  await withChrome({ tabs: [TAB1, TAB2] }, async (chrome) => {
    const t = (tab) => ({ ...tab, wsUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/${tab.id}` });
    const first = (await m.attachTo(t(TAB1))).att;
    first.pushConsole({ level: 'log', text: 'kept' });
    const again = await m.attachTo(t(TAB1));
    assert.equal(again.already, true);
    assert.equal(again.att, first);
    assert.equal(first.console.length, 1);
    const second = (await m.attachTo(t(TAB2))).att;
    assert.notEqual(second, first);
    assert.equal(first.dead, true);
    assert.equal(first.conn.closed, true);
    assert.equal(m.state.att, second);
    assert.equal(second.console.length, 0);
  });
});

test('ensureAttached auto-attaches the only tab; after the connection drops: read shows a banner, live reconnects', async () => {
  await withChrome({ tabs: [TAB1] }, async (chrome) => {
    const auto = await m.ensureAttached('read');
    assert.match(auto.notes[0], /^\(auto-attached to \[T1\] One — http:\/\/h:1\/one\)$/);
    assert.equal(auto.att.connected, true);
    chrome.clients[0].destroy();
    await waitUntil(() => !auto.att.connected);
    const stale = await m.ensureAttached('read');
    assert.equal(stale.att, auto.att);
    assert.match(stale.notes[0], /^⚠ Disconnected from tab \(closed \(code \d+/);
    const live = await m.ensureAttached('live');
    assert.notEqual(live.att, auto.att);
    assert.equal(live.att.connected, true);
    assert.match(live.notes[0], /^\(reconnected to \[T1\] One.*; previous console\/network buffers were reset\)$/);
  });
});

test('ensureAttached(live) says so when the stale attachment tab is gone and its buffers are replaced by another tab', async () => {
  await withChrome({ tabs: [TAB1] }, async (chrome) => {
    const first = (await m.ensureAttached('read')).att;
    chrome.tabs.splice(0, 1, TAB2); // the old tab vanished, a different one is open
    chrome.clients[0].destroy();
    await waitUntil(() => !first.connected);
    const r = await m.ensureAttached('live');
    assert.equal(r.att.target.id, 'T2');
    assert.match(r.notes[0], /^\(auto-attached to \[T2\] Two.*; buffers of previous tab \[T1\] were discarded\)$/);
  });
});

test('a failed attach (enable error or unreachable socket) leaves the working attachment in place and usable', async () => {
  await withChrome({ tabs: [TAB1, TAB2], handler: ({ tabId, method }) => { if (tabId === 'T2' && method === 'Runtime.enable') throw new Fail('no runtime'); return {}; } }, async (chrome) => {
    const t = (tab) => ({ ...tab, wsUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/${tab.id}` });
    const first = (await m.attachTo(t(TAB1))).att;
    first.pushConsole({ level: 'log', text: 'keep' });
    await assert.rejects(() => m.attachTo(t(TAB2)), /no runtime/);
    assert.equal(m.state.att, first);
    assert.equal(first.dead, false);
    assert.equal(first.connected, true);
    assert.equal(first.console.length, 1);
    assert.deepEqual(await first.conn.send('Ping'), {});
    const dead = await deadWsPort();
    await assert.rejects(() => m.attachTo({ id: 'T3', title: '', url: '', wsUrl: `ws://127.0.0.1:${dead}/devtools/page/T3` }), m.ToolError);
    assert.equal(m.state.att, first);
    assert.equal(first.conn.closed, false);
  });
});

test('toolAttach: ambiguous without "tab", exact id attaches and reports replayed messages, repeat says already attached', async () => {
  await withChrome({ tabs: [TAB1, TAB2], handler: ({ method }, client) => { if (method === 'Runtime.enable') { client.emit('Runtime.consoleAPICalled', logCall('a')); client.emit('Runtime.consoleAPICalled', logCall('b')); } return {}; } }, async () => {
    await assert.rejects(() => m.toolAttach({}), (e) => e instanceof m.ToolError && /^2 tabs open — pass "tab"/.test(e.message));
    const out = await m.toolAttach({ tab: 'T2' });
    assert.equal(out, 'Attached to [T2] Two — http://h:1/two. Collecting console (Runtime+Log) and network. 2 console messages replayed. Requests made before attaching are not captured — use reload.');
    assert.match(await m.toolAttach({ tab: 'two' }), /^Already attached to \[T2\]/);
  });
});

test('eval over the real socket works; a mid-call drop tells the model to re-attach', async () => {
  await withChrome({ tabs: [TAB1], handler: ({ method, params }, client) => {
    if (method !== 'Runtime.evaluate') return {};
    if (params.expression === 'drop') { client.destroy(); return NO_REPLY; }
    return { result: { type: 'number', value: 2, description: '2' } };
  } }, async () => {
    assert.equal(await m.toolEval({ expression: '1+1' }), '(auto-attached to [T1] One — http://h:1/one)\n2');
    await assert.rejects(() => m.toolEval({ expression: 'drop' }), (e) => e instanceof m.ToolError && /closed while waiting for Runtime\.evaluate\. Chrome is still reachable; call attach to reconnect/.test(e.message));
  });
});
