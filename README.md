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

## Dashboard authentication

Password login (session cookie, 30 days). Brute-force protection: 5 wrong
attempts from one IP locks that IP out for 15 minutes (429 + `retry_after_sec`);
guard state persists across restarts, and every failure/lockout/login hits the
container log.

- Set or change the password: put it in the container env once
  (`DASHBOARD_PASSWORD=...`), restart the sidecar - a scrypt hash is written to
  `/app/data/dashboard-password.hash` - then remove the env var. The plaintext
  is never stored.
- Public endpoints (no login): `GET /api/health`, `GET /api/status`,
  `GET /api/login-code`, `GET /api/auth-check`, `POST /api/login`,
  `POST /api/logout`. Everything else needs the session cookie.
- `POST /api/revive-key` additionally accepts the shared service token
  (`/app/data/dashboard-token`, bearer) so pulse can trigger key revival
  machine-to-machine. That token no longer logs into the dashboard UI.

## DonutSMP API key auto-revival

When pulse's DonutSMP key dies it POSTs `/api/revive-key` here. The sidecar
writes a request file, arms the `apikey.py` MineScript autorun, waits a random
20-90s like a person coming back to the keyboard, reconnects to DonutSMP, and
the in-game script idles human-plausibly before running `/api` and writing the
captured key to a result file. The sidecar then POSTs the key to pulse's
callback and disarms the autorun. Cooldowns: 4h after a successful capture,
30min after a failure. `GET /api/revive-key` shows state. Anti-ban notes: no
instant login->command->quit, random delays everywhere, the client stays
online after capturing.
