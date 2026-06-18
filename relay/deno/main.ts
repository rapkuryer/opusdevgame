// OPUSDEV multiplayer relay — Deno Deploy (free WebSocket hosting).
const MAX_PLAYERS = 10;
const rooms = new Map();
let nextClientId = 1;

function sanitizeNick(raw) {
  const s = String(raw || "Courier").trim().slice(0, 16);
  const clean = s.replace(/[^\w\s.\-]/g, "").trim();
  return clean || "Courier";
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
    if (peer !== sender && peer.readyState === WebSocket.OPEN) peer.send(payload);
  }
}

function peerSnapshot(p) {
  return { id: p.id, nick: p.nick, p: p.last?.p, q: p.last?.q, a: p.last?.a };
}

function joinRoom(ws) {
  const roomId = findRoom();
  const set = rooms.get(roomId);
  if (set.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: "full" }));
    ws.close();
    return;
  }
  ws.roomId = roomId;
  const peers = [...set].map(peerSnapshot);
  set.add(ws);
  ws.send(JSON.stringify({ type: "welcome", id: ws.id, room: roomId, peers }));
  broadcast(roomId, ws, { type: "join", id: ws.id, nick: ws.nick });
}

Deno.serve((req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("opusdev multiplayer relay", { status: 200 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.id = nextClientId++;
  socket.nick = null;
  socket.roomId = null;
  socket.last = null;

  const helloTimer = setTimeout(() => {
    if (!socket.roomId) socket.close();
  }, 12000);

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }

    if (msg.type === "hello" && !socket.roomId) {
      clearTimeout(helloTimer);
      socket.nick = sanitizeNick(msg.nick);
      joinRoom(socket);
      return;
    }

    if (msg.type === "state" && socket.roomId) {
      socket.last = { p: msg.p, q: msg.q, a: msg.a };
      broadcast(socket.roomId, socket, {
        type: "state",
        id: socket.id,
        nick: socket.nick,
        p: msg.p,
        q: msg.q,
        a: msg.a,
      });
    }
  };

  socket.onclose = () => {
    clearTimeout(helloTimer);
    if (!socket.roomId) return;
    const set = rooms.get(socket.roomId);
    if (!set) return;
    set.delete(socket);
    broadcast(socket.roomId, socket, { type: "leave", id: socket.id });
    if (set.size === 0) rooms.delete(socket.roomId);
  };

  return response;
});
