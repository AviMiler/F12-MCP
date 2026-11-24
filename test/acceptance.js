// test/acceptance.js — end-to-end acceptance test (spec §10): real headless Chrome/Edge + test server + f12-mcp.js driven over stdio JSON-RPC.
// Run: node test/acceptance.js   (HEADED=1 for a visible browser, CHROME_PATH=... to pick a browser). Prints PASS/FAIL per check; exit code 1 on any failure.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startServer } = require('./server.js');

const ROOT = path.join(__dirname, '..');
const MCP_PATH = path.join(ROOT, 'f12-mcp.js');
const HARD_TIMEOUT_MS = 150_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const violations = []; // non-JSON-RPC lines on stdout (checked at the end)

// ------------------------------------------------------------------ helpers
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`No Chrome/Edge found. Set CHROME_PATH. Tried: ${candidates.join(', ')}`);
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => (port === 9222 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

const killTree = (pid) => { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); };
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (e) { console.error(`WARN could not remove ${dir}: ${e.message}`); } };

function assertThat(cond, msg) { if (!cond) throw new Error(msg); }
function assertIncludes(text, needle, label) { assertThat(text.includes(needle), `${label || 'output'} should include ${JSON.stringify(needle)}\n--- got ---\n${text}`); }
function assertExcludes(text, needle, label) { assertThat(!text.includes(needle), `${label || 'output'} should NOT include ${JSON.stringify(needle)}\n--- got ---\n${text}`); }
function assertMatches(text, re, label) { const m = re.exec(text); assertThat(m, `${label || 'output'} should match ${re}\n--- got ---\n${text}`); return m; }

/** Minimal MCP client over the child's stdio (newline-delimited JSON-RPC). */
class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.waiting = new Map();
    this.unsolicited = [];
    this.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') continue;
        this.onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    this.stderr = '';
    child.stderr.on('data', (c) => { this.stderr += c; });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { violations.push(`stdout line is not JSON: ${line.slice(0, 200)}`); return; }
    const isRpc = msg && typeof msg === 'object' && (Array.isArray(msg) || msg.jsonrpc === '2.0');
    if (!isRpc) { violations.push(`stdout JSON is not JSON-RPC 2.0: ${line.slice(0, 200)}`); return; }
    if (msg.id !== undefined && msg.id !== null && this.waiting.has(msg.id)) { this.waiting.get(msg.id)(msg); this.waiting.delete(msg.id); } else this.unsolicited.push(msg);
  }

  writeRaw(text) { this.child.stdin.write(`${text}\n`); }
  notify(method, params) { this.writeRaw(JSON.stringify({ jsonrpc: '2.0', method, params })); }

  rpc(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`rpc ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** @returns {Promise<{text:string,isError:boolean}>} */
  async tool(name, args = {}, timeoutMs) {
    const r = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`tools/call ${name} protocol error: ${JSON.stringify(r.error)}`);
    return { text: r.result.content.map((c) => c.text).join('\n'), isError: !!r.result.isError };
  }

  /** Like tool(), but fails the check when the tool reports an error. */
  async ok(name, args = {}, timeoutMs) {
    const r = await this.tool(name, args, timeoutMs);
    assertThat(!r.isError, `${name} ${JSON.stringify(args)} returned an error: ${r.text}`);
    return r.text;
  }
}

// ------------------------------------------------------------------ browser control
function launchBrowser(browser, port, profile, url) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...(process.env.HEADED === '1' ? [] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    url,
  ];
  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => console.error(`browser spawn error: ${e.message}`));
  return child;
}

async function devtoolsUp(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  return r.ok;
}

// ------------------------------------------------------------------ main
async function main() {
  const browser = findBrowser();
  console.log(`Browser: ${browser}${process.env.HEADED === '1' ? ' (headed)' : ' (headless)'}`);
  const server = await startServer(0);
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'f12-mcp-profile-'));
  const testUrl = `http://127.0.0.1:${server.port}/`;
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').split('\n');
  const lineOf = (marker) => { const i = appSrc.findIndex((l) => l.includes(marker)); assertThat(i >= 0, `marker ${marker} not in app.js`); return i + 1; };

  let chrome = launchBrowser(browser, cdpPort, profile, testUrl);
  let mcp = null;
  const cleanup = () => { try { if (mcp) mcp.child.kill(); } catch { /* ignore */ } killTree(chrome && chrome.pid); };
  const hardTimer = setTimeout(() => { console.error('FAIL hard timeout'); cleanup(); process.exit(1); }, HARD_TIMEOUT_MS);

  const check = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name} (${Date.now() - t0} ms)`); } catch (e) {
      results.push({ name, ok: false, err: e }); console.log(`FAIL ${name}\n${String(e.message).split('\n').map((l) => `     ${l}`).join('\n')}`);
    }
  };

  try {
    await waitFor(() => devtoolsUp(cdpPort), 30_000, `${browser} to expose DevTools on :${cdpPort}`);
    mcp = new McpClient(spawn(process.execPath, [MCP_PATH, '--port', String(cdpPort)], { stdio: ['pipe', 'pipe', 'pipe'] }));
    let netMaxIdBeforeReload = 0;

    await check('1 no external imports (only node: builtins; f12-mcp.js none at all)', async () => {
      const files = [MCP_PATH, ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f))];
      const bad = [];
      for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const specs = [];
        for (const re of [/\brequire\s*\(\s*['"`]([^'"`]+)['"`]/g, /^\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g]) {
          for (const m of src.matchAll(re)) specs.push(m[1]);
        }
        const isMcp = f === MCP_PATH;
        for (const s of specs) if (isMcp || !(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../'))) bad.push(`${path.basename(f)}: ${s}`);
      }
      assertThat(bad.length === 0, `non-builtin imports found: ${bad.join(', ')}`);
    });

    await check('2 MCP protocol: initialize, initialized, ping, tools/list, -32601, -32700', async () => {
      const init = await mcp.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } });
      assertThat(init.result.protocolVersion === '2025-03-26', `protocolVersion not echoed: ${JSON.stringify(init.result)}`);
      assertThat(init.result.serverInfo.name === 'f12-mcp', 'serverInfo.name');
      const before = mcp.unsolicited.length;
      mcp.notify('notifications/initialized');
      const ping = await mcp.rpc('ping', {});
      assertThat(JSON.stringify(ping.result) === '{}', `ping result: ${JSON.stringify(ping)}`);
      assertThat(mcp.unsolicited.length === before, 'notifications/initialized must not be answered');
      const list = await mcp.rpc('tools/list', {});
      const names = list.result.tools.map((t) => t.name).sort().join(',');
      assertThat(names === 'attach,console,eval,list_tabs,network,network_detail,reload', `tool names: ${names}`);
      const unknown = await mcp.rpc('nope/nothing', {});
      assertThat(unknown.error && unknown.error.code === -32601, `unknown method: ${JSON.stringify(unknown)}`);
      mcp.writeRaw('this is not json');
      await waitFor(() => mcp.unsolicited.some((m) => m.error && m.error.code === -32700 && m.id === null), 3000, 'a -32700 reply to garbage input');
    });

    await check('3 list_tabs shows the test page', async () => {
      assertIncludes(await mcp.ok('list_tabs'), testUrl, 'list_tabs');
    });

    await check('4 ambiguity: two matching tabs -> attach errors listing both', async () => {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(`${testUrl}?second=1`)}`, { method: 'PUT' });
      assertThat(res.ok, `PUT /json/new failed: ${res.status}`);
      const created = await res.json();
      try {
        await waitFor(async () => (await mcp.ok('list_tabs')).includes('?second=1'), 5000, 'second tab to be listed');
        const r = await mcp.tool('attach', { tab: '127.0.0.1' });
        assertThat(r.isError, `attach should fail on ambiguity: ${r.text}`);
        assertMatches(r.text, /2 tabs match/, 'ambiguity error');
        assertIncludes(r.text, testUrl, 'ambiguity error');
        assertIncludes(r.text, '?second=1', 'ambiguity error');
      } finally {
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${created.id}`).catch(() => {});
        await waitFor(async () => !(await mcp.ok('list_tabs')).includes('?second=1'), 5000, 'second tab to close');
      }
    });

    await check('5 attach, reload, data arrives', async () => {
      assertMatches(await mcp.ok('attach', {}), /^Attached to \[/, 'attach');
      assertMatches(await mcp.ok('reload'), /^Reloaded \(ignore_cache=false\)\. Buffers cleared\. Load event after \d+ ms\./, 'reload');
      await waitFor(async () => (await mcp.ok('console', { level: 'error' })).includes('uncaught boom'), 5000, 'the uncaught exception to show up');
    });

    await check('6 console: error level has error + exception with file:line, excludes warn/log; warn level has warn', async () => {
      const errLine = lineOf('f12-test: error message');
      const boomLine = lineOf('uncaught boom');
      const err = await mcp.ok('console', { level: 'error' });
      assertMatches(err, new RegExp(`error \\S*app\\.js:${errLine} f12-test: error message`), 'console error');
      assertMatches(err, new RegExp(`exception \\S*app\\.js:${boomLine} Uncaught Error: f12-test: uncaught boom`), 'console exception');
      assertIncludes(err, 'at explode', 'exception stack');
      assertExcludes(err, 'f12-test: warn message', 'console level=error');
      assertExcludes(err, 'f12-test: log message', 'console level=error');
      const warn = await mcp.ok('console', { level: 'warn' });
      assertMatches(warn, new RegExp(`warn \\S*app\\.js:${lineOf('f12-test: warn message')} f12-test: warn message`), 'console warn');
      assertExcludes(warn, 'f12-test: log message', 'console level=warn');
      const all = await mcp.ok('console', {});
      assertMatches(all, /f12-test: log message Object|f12-test: log message \{a: 1\}/, 'console all'); // replay-free after reload: live preview expected
    });

    await check('7 network failed_only: the 500 and the refused connection, not the 200', async () => {
      const out = await mcp.ok('network', { failed_only: true });
      assertMatches(out, /GET \/api\/fail 500 Fetch/, 'failed_only');
      assertMatches(out, /FAILED net::ERR_CONNECTION_REFUSED/, 'failed_only');
      assertExcludes(out, '/api/ok', 'failed_only');
    });

    let postId;
    await check('8 network_detail of the POST: headers, payload, response body', async () => {
      const list = await mcp.ok('network', { url_contains: '/api/echo' });
      postId = Number(assertMatches(list, /#(\d+) POST \/api\/echo/, 'network list')[1]);
      const d = await mcp.ok('network_detail', { id: postId });
      assertMatches(d, /x-test: 1/i, 'request headers');
      assertIncludes(d, '{"name":"f12","n":42}', 'payload');
      assertIncludes(d, 'received', 'response body');
      assertMatches(d, /Status: 200 OK/, 'status');
    });

    await check('9 long body is truncated with the Hebrew note; max_body_chars is honored', async () => {
      const id = Number(assertMatches(await mcp.ok('network', { url_contains: '/api/long' }), /#(\d+) GET \/api\/long/)[1]);
      const d = await mcp.ok('network_detail', { id });
      const m = assertMatches(d, /\[נחתך, 4000 תווים מתוך (\d+)\]/, 'truncation note');
      assertThat(Number(m[1]) > 4000, `original length should exceed 4000, got ${m[1]}`);
      assertIncludes(await mcp.ok('network_detail', { id, max_body_chars: 100 }), 'נחתך, 100', 'custom truncation');
    });

    await check('10 image is classified binary and hidden from the api filter', async () => {
      const all = await mcp.ok('network', { filter: 'all' });
      const m = assertMatches(all, /#(\d+) GET \/img\/pixel\.png/, 'filter=all');
      assertMatches(await mcp.ok('network_detail', { id: Number(m[1]) }), /\[binary, [\d.]+ KB\]/, 'image detail');
      assertExcludes(await mcp.ok('network', {}), 'pixel.png', 'filter=api');
    });

    await check('11 redirect: one entry showing the 302 hop', async () => {
      const list = await mcp.ok('network', { filter: 'all' });
      const m = assertMatches(list, /#(\d+) GET \/api\/ok 200 .*\(redirected ×1 from \/api\/redirect\)/, 'redirect line');
      const d = await mcp.ok('network_detail', { id: Number(m[1]) });
      assertMatches(d, /1\. 302 GET \/api\/redirect/, 'redirect chain');
    });

    await check('12 eval: arithmetic, promise, rejection, DOM node and window', async () => {
      assertThat((await mcp.ok('eval', { expression: '1+1' })).trim() === '2', 'eval 1+1');
      assertThat((await mcp.ok('eval', { expression: 'new Promise(r => setTimeout(() => r(42), 100))' })).trim() === '42', 'eval promise');
      const rej = await mcp.tool('eval', { expression: 'Promise.reject(new Error("nope"))' });
      assertThat(rej.isError && rej.text.includes('nope'), `rejected promise should be an error mentioning nope: ${JSON.stringify(rej)}`);
      const body = (await mcp.ok('eval', { expression: 'window.__n = (window.__n || 0) + 1; document.body' })).trim();
      assertThat(body.length > 0 && body !== '{}', `eval document.body should be descriptive, got ${JSON.stringify(body)}`);
      assertThat((await mcp.ok('eval', { expression: 'window.__n' })).trim() === '1', 'the expression must run exactly once (even for non-serializable results)');
      const win = (await mcp.ok('eval', { expression: 'window' })).trim();
      assertThat(win.length > 0 && win !== '{}', `eval window should be descriptive, got ${JSON.stringify(win)}`);
      assertThat((await mcp.ok('eval', { expression: 'window.__m = (window.__m || 0) + 1; ({ a: [1, 2, 3] })' })).trim() === '{"a":[1,2,3]}', 'eval of a plain object');
      assertThat((await mcp.ok('eval', { expression: 'window.__m' })).trim() === '1', 'a serializable object result must not re-run the expression either');
      assertThat((await mcp.ok('eval', { expression: 'document.title' })).trim() === 'F12 Test', 'eval document.title');
    });

    await check('13 reload clears buffers and re-captures from the start', async () => {
      const before = await mcp.ok('network', { filter: 'all' });
      netMaxIdBeforeReload = Math.max(...[...before.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1])));
      assertThat(netMaxIdBeforeReload > 0, 'there should be requests before reload');
      await mcp.ok('reload');
      await waitFor(async () => (await mcp.ok('console', { level: 'error' })).includes('uncaught boom'), 5000, 'the exception after reload');
      const after = await mcp.ok('network', { filter: 'all' });
      const ids = [...after.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
      assertThat(ids.length >= 5, `expected the page's requests after reload, got ${ids.length}\n${after}`);
      assertThat(ids.every((i) => i > netMaxIdBeforeReload), `ids after reload must all exceed ${netMaxIdBeforeReload}: ${ids.join(',')}`);
      assertMatches(after, /GET \/ 200 Document/, 'document request after reload');
    });

    await check('14 console clear empties the buffer', async () => {
      const cleared = await mcp.ok('console', { clear: true });
      assertIncludes(cleared, '(console buffer cleared)', 'clear');
      assertMatches(await mcp.ok('console', {}), /^No console messages/, 'after clear');
    });

    await check('15 Chrome restart: clear errors while down, banner for old data, attach works after restart', async () => {
      killTree(chrome.pid);
      await waitFor(async () => { try { await devtoolsUp(cdpPort); return false; } catch { return true; } }, 15_000, 'Chrome to go away');
      const down = new RegExp(`cannot reach Chrome at 127\\.0\\.0\\.1:${cdpPort}`, 'i');
      const lt = await mcp.tool('list_tabs');
      assertThat(lt.isError && down.test(lt.text), `list_tabs while down: ${JSON.stringify(lt)}`);
      const ev = await mcp.tool('eval', { expression: '1+1' });
      assertThat(ev.isError && down.test(ev.text), `eval while down: ${JSON.stringify(ev)}`);
      assertIncludes(await mcp.ok('network', { filter: 'all' }), '⚠ Disconnected from tab', 'network after disconnect (old data + banner)');
      chrome = launchBrowser(browser, cdpPort, profile, testUrl);
      await waitFor(() => devtoolsUp(cdpPort), 30_000, 'Chrome to come back');
      await waitFor(async () => (await mcp.ok('list_tabs')).includes(testUrl), 10_000, 'the test page to be listed after restart');
      let attached;
      await waitFor(async () => { const r = await mcp.tool('attach', { tab: `127.0.0.1:${server.port}` }); attached = r; return !r.isError; }, 10_000, 'attach after restart');
      assertMatches(attached.text, /^Attached to \[/, 'attach after restart');
      assertThat((await mcp.ok('eval', { expression: '1+1' })).trim() === '2', 'eval after restart');
    });

    await check('16 teardown: stdout was protocol-only; closing stdin exits 0 quickly', async () => {
      assertThat(violations.length === 0, `non-protocol stdout output:\n${violations.join('\n')}`);
      mcp.child.stdin.end();
      const exit = await Promise.race([mcp.exited, sleep(3000).then(() => null)]);
      assertThat(exit !== null, 'MCP server did not exit within 3 s after stdin closed');
      assertThat(exit.code === 0, `MCP server exit code ${exit.code} (${exit.signal})\nstderr:\n${mcp.stderr}`);
      mcp = null;
    });
  } finally {
    clearTimeout(hardTimer);
    cleanup();
    await server.close();
    await sleep(500);
    rmDir(profile);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(`FAIL harness error: ${e.stack || e.message}`); process.exit(1); });
