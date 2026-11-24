// test/fake-cdp.js — minimal fake Chrome DevTools endpoint (HTTP /json/list + RFC 6455 WebSocket) for testing f12-mcp's connection and session logic without a browser.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Return from a command handler to leave the command unanswered (to exercise timeouts). */
const NO_REPLY = Symbol('no reply');
/** Throw from a command handler to answer with a CDP protocol error. */
class Fail extends Error {
  constructor(message, code = -32000) { super(message); this.code = code; }
}

/** @returns {Buffer} one unmasked server->client frame. */
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x80 | opcode;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return h;
  })();
  return Buffer.concat([head, payload]);
}

/** One accepted WebSocket client of the fake server. */
class FakeClient {
  constructor(socket, tabId) {
    this.socket = socket;
    this.tabId = tabId;
    this.closed = false;
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => {});
  }

  /** Pushes a CDP event to the client. */
  emit(method, params = {}) { this.sendRaw(JSON.stringify({ method, params })); }
  sendRaw(text) { if (!this.socket.destroyed) this.socket.write(frame(0x1, Buffer.from(text))); }
  /** Orderly close (close frame, then end). */
  close() { if (!this.socket.destroyed) { this.socket.write(frame(0x8, Buffer.from([0x03, 0xe8]))); this.socket.end(); } }
  /** Abrupt TCP drop, like a killed browser. */
  destroy() { this.socket.destroy(); }
}

/**
 * @param {{tabs: {id:string,title:string,url:string,type?:string}[], handler?: (cmd:{tabId:string,id:number,method:string,params:object}, client:FakeClient)=>*}} opts
 * @returns {Promise<{port:number, tabs:object[], clients:FakeClient[], commands:{tabId:string,method:string,params:object}[], close:()=>Promise<void>}>}
 */
async function startFakeChrome({ tabs, handler = () => ({}) }) {
  const clients = [];
  const commands = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const body = tabs.map((t) => ({ type: 'page', ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${t.id}` }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } else { res.writeHead(404); res.end(); }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => {
    const tabId = req.url.split('/').pop();
    const key = req.headers['sec-websocket-key'];
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const client = new FakeClient(socket, tabId);
    clients.push(client);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) { client.close(); return; }
        if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
        if (opcode !== 0x1) continue;
        const msg = JSON.parse(payload.toString('utf8'));
        commands.push({ tabId, method: msg.method, params: msg.params });
        Promise.resolve().then(() => handler({ tabId, id: msg.id, method: msg.method, params: msg.params }, client)).then((result) => {
          if (result !== NO_REPLY) client.sendRaw(JSON.stringify({ id: msg.id, result: result ?? {} }));
        }, (err) => {
          client.sendRaw(JSON.stringify({ id: msg.id, error: { code: err.code ?? -32000, message: err.message } }));
        });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    tabs,
    clients,
    commands,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

module.exports = { startFakeChrome, NO_REPLY, Fail };
