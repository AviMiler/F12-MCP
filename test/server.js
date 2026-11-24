// test/server.js — dependency-free local HTTP server that serves the f12-mcp test page and the API endpoints it exercises.
// Used by test/acceptance.js (via startServer) and runnable standalone: node test/server.js [port]  (default 8765).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf @returns {number} CRC-32 as used by PNG chunks. */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @returns {Buffer} a PNG chunk (length, type, data, crc). */
function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** @returns {Buffer} a valid 64x64 RGB gradient PNG, generated in code (no asset file needed). */
function makePng() {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = Math.round((x / (w - 1)) * 255);
      raw[row + 2 + x * 3] = Math.round((y / (h - 1)) * 255);
      raw[row + 3 + x * 3] = 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @returns {Promise<number>} a TCP port on 127.0.0.1 that nothing listens on (bound then released). */
function findDeadPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * @param {number} [port] 0 = pick a free port
 * @returns {Promise<{port:number, deadPort:number, close:()=>Promise<void>}>}
 */
async function startServer(port = 0) {
  const deadPort = await findDeadPort();
  const png = makePng();
  const page = fs.readFileSync(path.join(__dirname, 'page.html'));
  // __DEAD_PORT__ -> number keeps the line count identical, so app.js line numbers match the source file.
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/__DEAD_PORT__/g, String(deadPort));
  const longJson = JSON.stringify({ text: 'lorem ipsum dolor sit amet '.repeat(400) });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const json = (status, obj) => reply(status, 'application/json', typeof obj === 'string' ? obj : JSON.stringify(obj));

    if (req.method === 'GET' && url.pathname === '/') return reply(200, 'text/html; charset=utf-8', page);
    if (req.method === 'GET' && url.pathname === '/app.js') return reply(200, 'application/javascript; charset=utf-8', app);
    if (req.method === 'GET' && url.pathname === '/api/ok') return json(200, { ok: true, items: [1, 2, 3] });
    if (req.method === 'GET' && url.pathname === '/api/fail') return json(500, { error: 'Internal failure', code: 'E_TEST' });
    if (req.method === 'GET' && url.pathname === '/api/long') return json(200, longJson);
    if (req.method === 'GET' && url.pathname === '/api/redirect') {
      res.writeHead(302, { Location: '/api/ok', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let received;
        try { received = JSON.parse(text); } catch { received = text; }
        json(200, { received, length: text.length });
      });
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/img/pixel.png') return reply(200, 'image/png', png);
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return json(404, { error: 'not found', path: url.pathname });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    deadPort,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

module.exports = { startServer };

if (require.main === module) {
  startServer(Number(process.argv[2] || 8765)).then((s) => {
    process.stderr.write(`f12 test server on http://127.0.0.1:${s.port}/ (dead port for the failing request: ${s.deadPort})\n`);
  });
}
