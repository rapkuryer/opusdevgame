# OPUSDEV — Tiny Planet

**OPUSDEV** is a browser 3D exploration game on a tiny stylized planet.  
Built with **Three.js** (WebGL), **three-mesh-bvh** collisions, and cel-shaded rendering — no install, desktop or mobile.

On **PLAY**, the world **materializes block by block** — hills, streets, trees, and buildings fly in and snap together around you as you explore.

## Live

**[https://opusdev.org](https://opusdev.org)**

Also deployable from [rapkuryer/opusdevgame](https://github.com/rapkuryer/opusdevgame) on [Vercel](https://vercel.com).

## Local development

```bash
npm install
npm start
# open http://localhost:8080
```

## Controls

- **WASD** — move
- **Mouse** — look around (360°)
- **Space** — jump
- **E** — interact

## Deploy to Vercel

1. Import this GitHub repo in Vercel.
2. Framework preset: **Other** (static site).
3. Build command: leave empty.
4. Output directory: `.` (root).
5. Install command: `npm install --omit=dev` (default from `vercel.json`).

`vercel.json` sets correct MIME headers for `.wasm`, `.drc`, `.ktx2`, and `.fbx` assets.

## Links

- **Play:** [opusdev.org](https://opusdev.org)
- Public docs: [github.com/rapkuryer/opusdev-docs](https://github.com/rapkuryer/opusdev-docs)
- Developer: [@0pusdev on X](https://x.com/0pusdev)
- Game: [@gameopusdev on X](https://x.com/gameopusdev)
- **Coin:** [pump.fun](https://pump.fun/coin/ENfSPZh5tGP9tjKQpJY3FArAq2UN4jn7MYDLQ4dCpump) — `ENfSPZh5tGP9tjKQpJY3FArAq2UN4jn7MYDLQ4dCpump`

## License

All rights reserved — assets and source are proprietary unless stated otherwise in `opusdev-docs`.
