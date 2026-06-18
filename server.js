// ---------------------------------------------------------------------------
// Messenger — tiny-planet courier.
// Node.js HTTP static server + WebSocket multiplayer relay.
//
//   npm install        (once, to fetch the `ws` package)
//   npm start          (serves the game + multiplayer on http://localhost:8080)
//
// Rooms are capped at MAX_PLAYERS so each little world stays calm (matching the
// reference game's 10-per-instance design). The server only relays transforms;
// all rendering/physics stays on the client.
// ---------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10;
const HELLO_TIMEOUT_MS = 12000;

function sanitizeNick(raw) {
  const s = String(raw || 'Courier').trim().slice(0, 16);
  const clean = s.replace(/[^\w\s.\-]/g, '').trim();
  return clean || 'Courier';
}

// --- static file server ------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.drc': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.normalize(path.join(__dirname, rel));
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server error');
  }
});

// --- WebSocket multiplayer relay --------------------------------------------
const wss = new WebSocketServer({ server });
const rooms = new Map();
let nextClientId = 1;

function findRoom() {
  for (const [id, set] of rooms) if (set.size < MAX_PLAYERS) return id;
  const id = 'room-' + (rooms.size + 1);
  rooms.set(id, new Set());
  return id;
}

function broadcast(roomId, sender, data) {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(data);
  for (const peer of set) {
    if (peer !== sender && peer.readyState === peer.OPEN) peer.send(payload);
  }
}

function peerSnapshot(p) {
  return { id: p.id, nick: p.nick, p: p.last?.p, q: p.last?.q, a: p.last?.a };
}

function joinRoom(ws) {
  const roomId = findRoom();
  const set = rooms.get(roomId);
  if (set.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }
  ws.roomId = roomId;
  const peers = [...set].map(peerSnapshot);
  set.add(ws);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id, room: roomId, peers }));
  broadcast(roomId, ws, { type: 'join', id: ws.id, nick: ws.nick });
  console.log(`[ws] ${ws.nick} (#${ws.id}) joined ${roomId} (${set.size}/${MAX_PLAYERS})`);
}

wss.on('connection', (ws) => {
  ws.id = nextClientId++;
  ws.nick = null;
  ws.roomId = null;
  ws.last = null;

  const helloTimer = setTimeout(() => {
    if (!ws.roomId) ws.close();
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === 'hello' && !ws.roomId) {
      clearTimeout(helloTimer);
      ws.nick = sanitizeNick(msg.nick);
      joinRoom(ws);
      return;
    }

    if (msg.type === 'state' && ws.roomId) {
      ws.last = { p: msg.p, q: msg.q, a: msg.a };
      broadcast(ws.roomId, ws, {
        type: 'state',
        id: ws.id,
        nick: ws.nick,
        p: msg.p,
        q: msg.q,
        a: msg.a,
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!ws.roomId) return;
    const set = rooms.get(ws.roomId);
    if (!set) return;
    set.delete(ws);
    broadcast(ws.roomId, ws, { type: 'leave', id: ws.id });
    if (set.size === 0) rooms.delete(ws.roomId);
    console.log(`[ws] ${ws.nick || '?'} (#${ws.id}) left ${ws.roomId}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Messenger running →  http://localhost:${PORT}`);
});
