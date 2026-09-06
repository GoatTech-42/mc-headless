#!/usr/bin/env bash
# mc-headless entrypoint — HeadlessMC fabric:1.21.11 (headless) + MineScript + dashboard sidecar.
#
# HeadlessMC home = /data (launcher runs with CWD=/data). Game dir = /data/.minecraft. Logs -> /data/logs.
# LWJGL needs a real display for texture uploads (splash screen) — HeadlessMC's
# -lwjgl stub can't do STBImage.stbi_load_from_memory -> exit 255. Run under
# Xvfb + Mesa software GL (llvmpipe) instead; fall back to -lwjgl if Xvfb absent.
set -u

HMC_HOME="${HMC_HOME:-/data}"
GDIR="${MC_GDIR:-/data/.minecraft}"
XMX="${JAVA_XMX:-1536M}"
LOGIN_TIMEOUT="${HMC_LOGIN_TIMEOUT:-600}"
# 1.18.2 -> 1.21.11 bump (2026-09-06): DonutSMP requires Minecraft >= 1.20.2.
VER="fabric:1.21.11"

# Locate the HeadlessMC wrapper jar (base image drops it in /headlessmc).
# Exact name first, then versioned glob. `tr -d '\r'` guards against CRLF line
# endings baked in by Windows checkouts.
HMC_JAR="$(ls /headlessmc/headlessmc-launcher-wrapper.jar /headlessmc/headlessmc-launcher-wrapper-*.jar 2>/dev/null | head -n1 | tr -d '\r')"
if [ -z "$HMC_JAR" ]; then
  echo "[entrypoint] FATAL: HeadlessMC wrapper jar not found in /headlessmc — holding container open" >&2
  sleep infinity
fi
# Run the launcher via absolute jar path so it works from any CWD.
hmc() { java -jar "$HMC_JAR" --command "$@"; }

mkdir -p "$HMC_HOME/HeadlessMC" "$HMC_HOME/logs" "$GDIR/mods" "$GDIR/minescript"
cd "$HMC_HOME" || { echo "[entrypoint] FATAL: cannot cd to $HMC_HOME" >&2; sleep infinity; }

log() { echo "[entrypoint] $*" | tee -a "$HMC_HOME/logs/entrypoint.log"; }

# --- Dashboard sidecar (node /app/server.js, port 3000) ---
if [ -f /app/server.js ]; then
  ( cd /app && PORT=3000 node server.js > "$HMC_HOME/logs/dashboard.log" 2>&1 & )
  log "dashboard started on :3000"
else
  log "/app/server.js not present — dashboard skipped"
fi

# --- HeadlessMC config: resource-lean + headless ---
CONF="$HMC_HOME/HeadlessMC/config.properties"
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
# mc-headless (generated)
hmc.assets.dummy=true
hmc.always.lwjgl.flag=false
hmc.auto.download.specifics=true
hmc.jline.enabled=false
hmc.java.versions=/opt/java/java17/bin/java;/opt/java/java8/bin/java;/opt/java/openjdk/bin/java
hmc.gamedir=$GDIR
EOF
  log "wrote config.properties"
fi

# --- ENFORCE: enable hmc auto-download of specifics on EVERY boot ---
# The 2026-09-06 rate-limit crash-loop is no longer possible: launch is now a
# foreground retry loop (no container restarts), so worst case is 1 GitHub req/min
# vs the 60/hr limit. Auto-download is required so hmc-specifics resolves the
# correct jar per game version (e.g. 1.21.11); cached jars are keyed per version.
sed -i 's/^hmc.auto.download.specifics=.*/hmc.auto.download.specifics=true/' "$CONF" || true
grep -q '^hmc.auto.download.specifics=' "$CONF" || echo 'hmc.auto.download.specifics=true' >> "$CONF"
log "enforced hmc.auto.download.specifics=true"

# Same for the LWJGL stub flag: we render under Xvfb + Mesa now, so HeadlessMC must
# NOT inject its -lwjgl stub (which breaks texture/splash uploads -> exit 255).
sed -i 's/^hmc.always.lwjgl.flag=.*/hmc.always.lwjgl.flag=false/' "$CONF" || true
grep -q '^hmc.always.lwjgl.flag=' "$CONF" || echo 'hmc.always.lwjgl.flag=false' >> "$CONF"
log "enforced hmc.always.lwjgl.flag=false"

# --- Pre-seed options.txt (lean rendering; unknown keys are ignored by MC) ---
OPTS="$GDIR/options.txt"
if [ ! -f "$OPTS" ]; then
  cat > "$OPTS" <<EOF
renderDistance:2
graphics:fast
pauseOnLostFocus:false
onboardAccessibility:false
vsync:false
fullscreen:false
EOF
  log "wrote options.txt"
fi

log "hmc home=$HMC_HOME gamedir=$GDIR xmx=$XMX jar=$HMC_JAR"

# --- Download game version + Fabric (once) ---
if [ ! -d "$HMC_HOME/versions/fabric-1.21.11" ]; then
  hmc download "$VER" 2>&1 | tee -a "$HMC_HOME/logs/download.log" || true
else
  log "version $VER already downloaded"
fi

# --- Mods: runtime-resolved from Modrinth API for 1.21.11 (no pinned CDN URLs) ---
# 1.18.2 -> 1.21.11 bump (2026-09-06): DonutSMP requires >= 1.20.2. The old CDN URLs were
# 1.18.2-pinned and now wrong; resolve newest 1.21.11 Fabric build per project instead.
# modrinth_dl <slug> <label>: query Modrinth API, take files[0], skip if already present.
# Uses python3 (jq NOT installed). Resolve/parse failure logs + continues (never aborts boot).
modrinth_dl() {
  local slug="${1:-}" label="${2:-}"
  local json url filename
  json="$(curl -fsSL "https://api.modrinth.com/v2/project/${slug}/version?game_versions=%5B%221.21.11%22%5D&loaders=%5B%22fabric%22%5D&limit=1" 2>/dev/null || true)"
  if [ -z "$json" ]; then
    log "WARN: resolve failed for $label ($slug) — continuing"
    return 0
  fi
  url="$(printf '%s' "$json" | python3 -c 'import sys,json; f=json.load(sys.stdin)[0]["files"][0]; print(f["url"])' 2>/dev/null || true)"
  filename="$(printf '%s' "$json" | python3 -c 'import sys,json; f=json.load(sys.stdin)[0]["files"][0]; print(f["filename"])' 2>/dev/null || true)"
  if [ -z "$url" ] || [ -z "$filename" ]; then
    log "WARN: parse failed for $label ($slug) — continuing"
    return 0
  fi
  log "resolved $label -> $filename"
  if [ -s "$GDIR/mods/$filename" ]; then
    log "mod $filename already present — skip"
    return 0
  fi
  log "downloading $filename"
  if ! curl -fsSL -o "$GDIR/mods/$filename" "$url"; then
    log "FAILED to download $filename"
    rm -f "$GDIR/mods/$filename"
  fi
}
modrinth_dl "P7dR8mSH" "fabric-api"
modrinth_dl "KcpXWngB" "minescript" # 5.0b11 is beta — no version_type filter, take first result
modrinth_dl "AANobbMI" "sodium"
modrinth_dl "gvQqBUqZ" "lithium"
modrinth_dl "uXXizFIs" "ferrite-core"
modrinth_dl "fQEb0iXm" "krypton"
modrinth_dl "hvFnDODi" "lazydfu"
# hmc-specifics (msg/gui/click control) auto-download at launch via hmc.auto.download.specifics=true.

# --- MineScript scripts: copy ALL user scripts baked into /app/scripts ---
if [ -d /app/scripts ]; then
  for f in /app/scripts/*.py; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    cp -f "$f" "$GDIR/minescript/$name"
    log "installed minescript script $name"
  done
fi

# --- Microsoft device-code login (surfaced via /data/logs/login.log) ---
# No credentials baked. `hmc login` prints a device code + URL and polls until the user
# approves it in a browser. The dashboard (later step) tails login.log to surface the code.
LOGIN_LOG="$HMC_HOME/logs/login.log"
# Stale-marker cleanup: drop the marker if login.log is empty or lacks success
# evidence, so a half-finished login is redone on restart.
if [ -f "$HMC_HOME/logs/.login-done" ]; then
  if [ ! -s "$LOGIN_LOG" ] || ! grep -qiE 'signed in|logged in|success|authenticated' "$LOGIN_LOG"; then
    rm -f "$HMC_HOME/logs/.login-done"
  fi
fi

if [ "${HMC_SKIP_LOGIN:-0}" = "1" ]; then
  log "login skipped (HMC_SKIP_LOGIN=1)"
elif [ -f "$HMC_HOME/logs/.login-done" ]; then
  log "login already completed (marker present)"
else
  log "starting device-code login — code will appear in /data/logs/login.log"
  hmc login >"$LOGIN_LOG" 2>&1 &
  LOGIN_PID=$!
  waited=0
  while kill -0 "$LOGIN_PID" 2>/dev/null && [ "$waited" -lt "$LOGIN_TIMEOUT" ]; do
    sleep 2; waited=$((waited+2))
  done
  if kill -0 "$LOGIN_PID" 2>/dev/null; then
    log "login still pending after ${LOGIN_TIMEOUT}s — launching anyway (may fail without account)"
  else
    wait "$LOGIN_PID" && touch "$HMC_HOME/logs/.login-done" && log "login completed"
  fi
fi
log "login process ended"

# --- Server auto-join target (host:port, written by dashboard) ---
# NOTE: if HeadlessMC rejects unknown game args, the launch below will fail —
# the --server/--port flags surface as unrecognized-argument errors in the logs.
MC_HOST=""
MC_PORT=""
TARGET="$HMC_HOME/server.target"
if [ -f "$TARGET" ] && [ -s "$TARGET" ]; then
  line="$(head -n1 "$TARGET" | tr -d '\r')"
  MC_HOST="${line%%:*}"
  MC_PORT="${line##*:}"
fi

# --- Launch (Xvfb software GL, lean heap) ---
# Resilient foreground retry loop (NO exec): if the game crashes, we sleep and retry
# instead of exiting — the container (and the dashboard sidecar) stay up.
# Fixes GitHub rate-limit crash-loop incident 2026-09-06.

# Xvfb + Mesa (llvmpipe): gives LWJGL a real display so splash/texture uploads work.
# HeadlessMC's -lwjgl stub broke STBImage.stbi_load_from_memory -> exit 255.
# USE_XVFB auto-detect; set Xvfb=:0 to disable (forces -lwjgl fallback).
USE_XVFB=1
if [ "${Xvfb:-}" = ":0" ]; then
  USE_XVFB=0
  log "Xvfb=:0 set — using -lwjgl fallback (no display)"
elif command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY=:99
  Xvfb "$DISPLAY" -screen 0 1280x720x24 >"$HMC_HOME/logs/xvfb.log" 2>&1 &
  log "Xvfb started on $DISPLAY (software GL via llvmpipe)"
else
  USE_XVFB=0
  log "WARNING: Xvfb binary not found — falling back to -lwjgl (texture uploads may fail)"
fi
if [ "$USE_XVFB" = "1" ]; then
  LWJGL_FLAG=""
  GL_MODE="xvfb+llvmpipe"
else
  LWJGL_FLAG="-lwjgl"
  GL_MODE="lwjgl-stub"
fi

EXTRA_ARGS=""
if [ -n "$MC_HOST" ] && [ -n "$MC_PORT" ]; then
  EXTRA_ARGS="--server $MC_HOST --port $MC_PORT"
  log "launching $VER ($GL_MODE, -Xmx$XMX) -> $MC_HOST:$MC_PORT"
else
  log "launching $VER ($GL_MODE, -Xmx$XMX) [main menu]"
fi

# hmc-cmd.log: dashboard appends live console commands here; the launch below tails it
# into the game's stdin (HMC launcher reads commands from stdin).
touch "$HMC_HOME/hmc-cmd.log"

attempt=0
while true; do
  attempt=$((attempt+1))
  log "launch attempt $attempt $VER ..."
  # Feed hmc-cmd.log into the launcher's stdin. tail stays open forever; the pipeline's
  # exit status is java's (last command in the pipe), so crash detection is unchanged.
  if tail -n0 -f "$HMC_HOME/hmc-cmd.log" 2>/dev/null | java -jar "$HMC_JAR" --command launch "$VER" $LWJGL_FLAG --jvm "-Xmx$XMX -XX:+UseG1GC -XX:MaxGCPauseMillis=50" $EXTRA_ARGS; then
    log "game exited cleanly (code $?)"
  else
    log "launch failed (code $?) — retry in 60s, dashboard stays up"
  fi
  sleep 60
done
