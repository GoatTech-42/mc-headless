# mc-headless

Headless Minecraft 1.21.11 (Fabric) + MineScript 5.0 + dashboard sidecar.

## Deploy

```sh
docker build -t mc-headless .
docker run -d --name mc-headless --restart unless-stopped -p 4202:3000 -v mc-data:/data mc-headless
```

Container maps host `:4202` -> container `:3000` (dashboard/HTTP). Game data persists in the `mc-data` volume.

## Verify

```sh
curl http://localhost:4202/api/health
# {"status":"ok","mc":"1.21.11","port":3000}
```

```sh
curl http://localhost:4202/api/status
# {"running":bool,"loginPending":bool,"version":"fabric:1.21.11","log":"..."}
```

## Port contract

- `server.js` listens on `process.env.PORT`, falling back to `3000` (`const PORT = Number(process.env.PORT) || 3000`).
- `entrypoint.sh` starts the dashboard with `PORT=3000 node server.js`.
- `Dockerfile` exposes `EXPOSE 3000`.
- Host maps `4202 -> 3000`; hit `http://localhost:4202/api/...`.

## Login

Device-code login runs on first start. Fetch code:

```sh
curl http://localhost:4202/api/login-code
```

## Controls

- Connect: live join (no restart).
- D-pad move: hold-free taps via key presses.
- Start afk: enables autorun each join (ends on disconnect).
- Telemetry: needs `\telemetry` autorun (preconfigured).
- Chat-send via dashboard: unreliable on 1.21 (signed chat) — use autorun scripts instead.
