# mc-headless

A Docker-packaged HeadlessMC client with a web dashboard and MineScript scripts. It runs a Minecraft client without a physical display, using Xvfb and software rendering. The dashboard handles connecting, disconnecting, logs and a small set of controls.

This is a self-hosted project, not a hosted service. Each installation has **one shared dashboard password**, not user accounts. A friend who wants their own password should run their own instance with separate data volumes. Do not share Minecraft account credentials or reuse another person's game-data volume.

## Before you install

- Use a Linux Docker host with Git and internet access for the image, game and mod downloads.
- Game login needs your own Microsoft account with access to Minecraft Java Edition. Dashboard-only testing does not need a game login.
- Test on a server you control or one that permits these scripts. Delays and randomized movement do not make automation ban-safe. Read the server's rules before joining.
- Start with local-only access. The dashboard exposes status, logs in status responses and pending Microsoft login codes without authentication. Do not port-forward an unconfigured instance.

### Version caveat

The current launcher in `entrypoint.sh` is hardcoded to `fabric:26.3`. The dashboard still reports `fabric:1.21.11`, and some Dockerfile comments mention 1.18.2. These labels are not proof of the running version. Check the game/launcher logs.

`MC_GAME_VERSION` defaults to `26.3` and selects Modrinth downloads only. Setting it to `1.21.11` does **not** switch the launcher. The launcher also checks for an old `fabric-1.21.11` directory before downloading the configured version. Treat version selection and matching Java/mod availability as unresolved compatibility work, not a supported version switch. The image uses an unpinned `latest` base. A successful image build or dashboard health response does not prove the game can launch.

## Install your own instance

```sh
git clone https://github.com/GoatTech-42/mc-headless.git
cd mc-headless
docker build -t mc-headless .
docker run -d --name mc-headless --restart unless-stopped \
  --cpus=2 --memory=3g \
  -p 127.0.0.1:4202:3000 \
  -v mc-data:/data \
  -v mc-dashboard:/app/data \
  mc-headless
```

The CPU and memory values are starting limits, not a guarantee that every game version fits. Keep caps in place and watch `docker stats mc-headless`. The Java heap defaults to `1280M`; the total container also includes Node, Xvfb and native rendering memory.

Open `http://localhost:4202`. On a fresh data volume, choose **Create password**, enter a password of 12-256 characters and confirm it. The dashboard saves a hash and logs you in immediately. No container restart is needed. Already-configured instances show **Log in** instead.

On a remote Docker host, leave the loopback binding in place and use an SSH tunnel:

```sh
ssh -N -L 4202:127.0.0.1:4202 your-user@your-host
```

Then open `http://localhost:4202` on your computer. Replace the SSH user/host with your own. Set the password before considering remote access. For remote access, put the entire dashboard behind a trusted HTTPS/auth gateway, including the nominally public API routes; the built-in password alone does not hide them.

### Two separate logins

1. **Dashboard password:** controls this installation. It is stored as a scrypt hash in `/app/data/dashboard-password.hash`.
2. **Microsoft device login:** authorizes the game account. First boot runs HeadlessMC login and waits up to 600 seconds. Follow the device-login link shown in the dashboard and confirm the intended Microsoft account there. Do not send your Microsoft password to this app.

`GET /api/login-code` returns 404 when no code is pending or login is already complete. If login times out, inspect `/data/logs/login.log` locally and restart your own container to retry. Do not post codes or account logs publicly.

## Check the installation

```sh
curl -fsS http://localhost:4202/api/health
curl -fsS http://localhost:4202/api/auth-check
docker logs --tail 100 mc-headless
docker stats --no-stream mc-headless
```

Health returns a JSON object with `status`, `mc` and `port`. It proves only that Node is serving HTTP. `auth-check` returns `authed` and `configured`. Before setup they are both false. After setup, `configured` stays true; `authed` depends on the requesting browser's session cookie.

`/api/status` reports process detection, a login-marker flag and recent entrypoint logs. `running: true` is not confirmation that the client joined a server. Verify a join in game logs or on your test server.

## Using the dashboard

- **Connect:** enter your permitted server's hostname or IPv4 address and port (default 25565). This saves `/data/server.target` and queues a live connect command. It does not restart the container. Hostnames/IPv4 are supported; IPv6 literals are not accepted by the API.
- **Disconnect:** queues a disconnect command. It does not stop the container or prevent future reconnects from an already-running integration.
- **Movement:** forward/back/left/right are 600 ms taps, jump is 400 ms and sneak is 800 ms. Stop releases those movement keys.
- **Look:** the current yaw/pitch API logs the requested orientation but does not send a working look command to the game. Do not mistake its `ok` response for a real turn.
- **Chat:** queues a launcher `msg` command, with a 256-character maximum. In-game signed-chat compatibility is not established; check the game log rather than relying on the success toast.
- **Start AFK:** enables a MineScript autorun and disconnects/rejoins after eight seconds. The bundled script looks upward, then holds sneak, attack and use. It is not passive idle and may interact with your world. Use only where allowed.
- **Stop AFK:** removes that autorun and disconnects to stop the running job. Reconnect manually when ready. Movement Stop does not replace Stop AFK.
- **Telemetry:** requires the `telemetry.py` script running in a world. Copying it into the image does not start it. The read endpoint returns the latest `TELEMETRY` log record, not a freshness guarantee. Missing data returns 404.

MineScript scripts are copied from `/app/scripts` into `/data/.minecraft/minescript` on each boot. Image copies overwrite scripts with the same name. `afk` and `telemetry` are the only names accepted by `/api/script`. Starting either script schedules a rejoin; plan for the interruption.

## Configuration and persistent data

| Setting | Default | What it changes |
| --- | --- | --- |
| `MC_XMX` | `1280M` | Game JVM heap. `JAVA_XMX` is not the entrypoint's heap setting. |
| `HMC_LOGIN_TIMEOUT` | `600` | Seconds to wait for device login before continuing. |
| `HMC_SKIP_LOGIN` | `0` | `1` skips login, but does not supply an account. |
| `MC_GAME_VERSION` | `26.3` | Mod download filter only; see the version caveat. |
| `HMC_HOME` | `/data` | Launcher home, target and command file. |
| `MC_GDIR` | `/data/.minecraft` | Game directory and scripts. |
| `MC_LOGS` | `/data/logs` | Dashboard's log-reading directory. Entrypoint logs remain under `HMC_HOME/logs`. |
| `DASH_DATA` | `/app/data` | Password hash, sessions, login guard and integration state. |
| `DASHBOARD_PASSWORD` | unset | Initial hash seed only if no valid hash already exists. Minimum four characters for this legacy path; prefer the first-run form and a long unique password. |
| `PORT` | `3000` | Standalone Node listener; Docker entrypoint explicitly sets it to 3000. Change the host mapping instead. |

Keep the default paths unless you have checked every component. In particular, `scripts/apikey.py` has a fixed `/data/.minecraft/minescript` path.

Persist **both** volumes: `/data` contains account/game data and logs; `/app/data` contains dashboard credentials and sessions. Docker's anonymous volume behavior is not a reliable replacement for naming and tracking the dashboard volume.

An existing hash takes priority over `DASHBOARD_PASSWORD`. Changing that environment variable is not a password reset. The first-run form cannot change a configured instance's password, and there is no self-service reset or per-user signup. An installation owner can stop their own container and deliberately reset its authentication storage; preserve backups and never delete another person's volumes to obtain access.

The launcher enforces lean graphics settings on each boot (10 FPS, low render/simulation distance, no shadows/clouds). Software rendering still uses CPU, including on disconnected screens. Keep Docker resource limits.

## Read-only API example

The browser manages its own `mch_session` cookie after login. For local tooling, supply a cookie jar that you obtained through your own authenticated session, keep it private and do not commit it:

```sh
curl -fsS -b ./private-cookies.txt \
  'http://localhost:4202/api/logs?lines=50'
curl -fsS -b ./private-cookies.txt \
  http://localhost:4202/api/telemetry
```

Protected routes return 401 without a valid cookie. Sessions last 30 days; logout removes the current session. Five failed logins from one IP lock it out for 15 minutes; the guard persists across restarts. `429` responses include `retry_after_sec`.

`GET /api/health`, `/api/status`, `/api/login-code` and `/api/auth-check` do not require a cookie. Login, logout and first-run setup are also reachable before login. Setup is disabled once a hash exists and cannot overwrite it.

## Optional key-revival integration

The repository also contains a service-token integration for requesting an in-game API key. It is not needed to install or use the dashboard. A revival request changes autorun configuration, disconnects/reconnects to the saved target, runs movement and `/api`, and sends a captured key to an internal callback. It can interrupt an active session. It has a 20-minute result timeout, a four-hour success cooldown and a 30-minute failure cooldown.

Do not enable or trigger it on someone else's account or on a server that forbids it. Randomized delays are not a ban-prevention guarantee. Keep the generated service token, result files and callback data private. The service token authenticates revival endpoints only, not dashboard login.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Fresh install asks for a password but has no create option | Update the image from this repository. Older UI builds only offered login. Use a new, separate dashboard volume for a new installation, not someone else's volume. |
| Setup says "already configured" | This instance already has a hash. Log in with its existing password. There is no second-user signup. |
| New password saved but login still fails on an older image | The old setup endpoint did not update the in-memory hash. Upgrade to this version; first-run setup now works without a restart. |
| Changed env password has no effect | A valid existing hash wins. `DASHBOARD_PASSWORD` seeds a fresh hash, it does not replace one. |
| Wrong password / 429 | Check the intended instance and password. Wait for the stated lockout instead of repeatedly retrying. |
| Dashboard loads but game does not | Read `entrypoint.log`, `download.log`, `login.log` and game `latest.log`. Check actual launcher version, Java requirement and mod compatibility. Health is not a game test. |
| Missing mods or Modrinth warning | Downloads are best-effort and log warnings without stopping boot. Confirm compatible Fabric builds exist for the selected mod filter. |
| High CPU or loud fans | Check `docker stats`. Keep the two-CPU cap, inspect software rendering/disconnect screens and stop your own container when unused. |
| Container killed / game repeats every minute | Check Docker's OOM state and launcher logs. Heap size is not total memory. The launcher retries every 60 seconds after game exit. |
| Telemetry blank or old | A world and working MineScript telemetry job are required. The reader can return an old log record. |
| Controls say success but nothing happens | Success means a command was queued. Check HeadlessMC specifics/mods, game state and game log; look is not implemented and mouse key names are unverified. |
| Login overlay missing after update | Hard reload the dashboard. The shell and auth-check are served without cache. |

Read local files without changing the game:

```sh
docker exec mc-headless tail -n 100 /data/logs/entrypoint.log
docker exec mc-headless tail -n 100 /data/logs/dashboard.log
docker exec mc-headless tail -n 100 /data/.minecraft/logs/latest.log
```

Some files do not exist until that component runs. Redact passwords, tokens, login codes, API keys and account identifiers before sharing logs.

## Updating and stopping

```sh
docker stop mc-headless
```

For an update, back up your volumes, rebuild the image, remove only the stopped container (without `-v`) and recreate it using the same named volumes and limits. Removing a container is not the same as deleting its data volumes. Never run a second client against an account that is already in use elsewhere.

## FAQ

**Can my friend set their own password on my dashboard?** No. This is one password per instance. They need their own installation for independent credentials. Only an unconfigured instance shows Create password.

**Is there a fee or paid API requirement?** No paid service is required by the dashboard. You supply the host and your own Minecraft entitlement; hosting and game-account costs are yours.

**Does it run without any rendering?** Not completely. Xvfb and software GL are used so texture loading works. No physical monitor is needed, but CPU rendering work remains.

**Does it prevent bans?** No. Server rules and enforcement still apply. Do not use automation where it is prohibited.

**Can I change versions with one env variable?** Not in the current source. See the version caveat before attempting a game launch.

**Can I test without joining a server?** Yes. Run the dashboard alone with Node 20+ and separate scratch directories. That tests HTTP/auth, not HeadlessMC:

```sh
npm ci --omit=dev
mkdir -p .local-test/home/logs .local-test/game .local-test/dashboard
HMC_HOME="$PWD/.local-test/home" MC_GDIR="$PWD/.local-test/game" \
  MC_LOGS="$PWD/.local-test/home/logs" DASH_DATA="$PWD/.local-test/dashboard" \
  PORT=3000 npm start
```

Node listens on all interfaces in this mode, so use a private test machine/firewall. Do not commit `.local-test`, cookie jars or credentials. No game process is launched by `npm start`.
