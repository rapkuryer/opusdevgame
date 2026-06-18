// ---------------------------------------------------------------------------
// Standalone WebSocket relay for production (Render / Railway / VPS).
// Static game stays on Vercel; clients connect here for multiplayer.
// ---------------------------------------------------------------------------
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8081;
const MAX_PLAYERS = 10;
const HELLO_TIMEOUT_MS = 12000;

const rooms = new Map();
let nextClientId = 1;

function sanitizeNick(raw) {
  const s = String(raw || 'Courier').trim().slice(0, 16);
  const clean = s.replace(/[^\w\s.\-]/g, '').trim();
  return clean || 'Courier';
}

function findRoom() {
  for (const [id, set] of rooms) if (set.size < MAX_PLAYERS) return id;
  const id = `room-${rooms.size + 1}`;
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
  return {
    id: p.id,
    nick: p.nick,
    p: p.last?.p,
    q: p.last?.q,
    a: p.last?.a,
  };
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

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('opusdev multiplayer relay');
});

const wss = new WebSocketServer({ server });

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
  console.log(`opusdev ws relay → port ${PORT}`);
});
