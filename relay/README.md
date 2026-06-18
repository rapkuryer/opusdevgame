# OPUSDEV WebSocket relay

Minimal multiplayer relay for production. The static game runs on Vercel; clients connect here for real-time sync.

## Deploy on Render (free)

1. Push this repo to GitHub.
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** → connect repo.
3. Render reads `render.yaml` and creates `opusdev-ws`.
4. Copy the service URL (e.g. `https://opusdev-ws.onrender.com`).
5. Set in `index.html`:

```html
window.__WS_URL = 'wss://opusdev-ws.onrender.com';
```

## Local

From project root: `npm start` — static files + WebSocket on the same port (`8080`).

## Protocol

- Client sends `{ type: 'hello', nick: '...' }` on connect.
- Client broadcasts `{ type: 'state', p, q, a, nick }` at ~12 Hz.
- Server relays to peers in the same room (max 10 players).
