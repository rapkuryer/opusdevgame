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
    // prevent path traversal
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
const rooms = new Map();           // roomId -> Set<ws>
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

wss.on('connection', (ws) => {
  const roomId = findRoom();
  const set = rooms.get(roomId);

  if (set.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'full' })); ws.close(); return; }

  ws.id = nextClientId++;
  ws.roomId = roomId;
  ws.last = null;

  // tell the newcomer who is already here
  const peers = [...set].map((p) => ({ id: p.id, p: p.last && p.last.p, q: p.last && p.last.q, a: p.last && p.last.a }));
  set.add(ws);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id, room: roomId, peers }));
  broadcast(roomId, ws, { type: 'join', id: ws.id });

  console.log(`[ws] client ${ws.id} joined ${roomId} (${set.size}/${MAX_PLAYERS})`);

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'state') {
      ws.last = { p: msg.p, q: msg.q, a: msg.a };
      broadcast(roomId, ws, { type: 'state', id: ws.id, p: msg.p, q: msg.q, a: msg.a });
    }
  });

  ws.on('close', () => {
    set.delete(ws);
    broadcast(roomId, ws, { type: 'leave', id: ws.id });
    if (set.size === 0) rooms.delete(roomId);
    console.log(`[ws] client ${ws.id} left ${roomId}`);
  });
});

server.listen(PORT, () => {
  console.log(`Messenger running →  http://localhost:${PORT}`);
});
