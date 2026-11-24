// test/app.js — page script for the f12-mcp acceptance test: emits console messages, an uncaught exception and a spread of network requests. One statement per line (the test derives expected line numbers from this file); bodies are read because Chrome only finishes a fetch once its body is consumed.
console.log('f12-test: log message', { a: 1 });
console.warn('f12-test: warn message');
console.error('f12-test: error message');
fetch('/api/ok').then(function (r) { return r.text(); });
fetch('/api/fail').then(function (r) { return r.text(); });
fetch('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test': '1' }, body: JSON.stringify({ name: 'f12', n: 42 }) }).then(function (r) { return r.text(); });
fetch('http://127.0.0.1:__DEAD_PORT__/nothing').catch(function () { console.log('f12-test: expected failure'); });
fetch('/api/long').then(function (r) { return r.text(); });
fetch('/api/redirect').then(function (r) { return r.text(); });
setTimeout(function explode() { throw new Error('f12-test: uncaught boom'); }, 50);
