'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const HMC_HOME = process.env.HMC_HOME || '/data';
const LOGS = process.env.MC_LOGS || '/data/logs';
const GDIR = process.env.MC_GDIR || '/data/.minecraft';
const VERSION = 'fabric:1.21.11';
const LOGIN_DONE = path.join(HMC_HOME, 'logs', '.login-done');
const SERVER_TARGET = path.join(HMC_HOME, 'server.target');
const HMC_CMD = path.join(HMC_HOME, 'hmc-cmd.log');

const DATA_DIR = process.env.DASH_DATA || '/app/data';
const TOKEN_FILE = path.join(DATA_DIR, 'dashboard-token');
function loadDashToken() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t.length >= 16) return t;
    }
    const t = require('crypto').randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
    console.log('dashboard token generated at ' + TOKEN_FILE);
    return t;
  } catch (e) { console.error('token load failed', e); return ''; }
}
const DASH_TOKEN = loadDashToken();

const app = express();
app.use(express.json());

// Static frontend (dir may not exist yet).
const pub = path.join(__dirname, 'public');
if (fs.existsSync(pub)) app.use((req,res,next)=>{ if(req.path==='/'||req.path.endsWith('.html')) res.setHeader('Cache-Control','no-store'); next(); }, express.static(pub));

// Password login with brute-force protection. Public: health, status,
// login-code, auth-check, login/logout. Everything else under /api needs a
// session cookie. DASH_TOKEN survives ONLY as the shared secret on the
// pulse revival endpoints (service-to-service) - it no longer logs anyone in.
const PASSWORD_HASH_FILE = path.join(DATA_DIR, 'dashboard-password.hash');
const SESSIONS_FILE = path.join(DATA_DIR, 'dashboard-sessions.json');
const LOGIN_GUARD_FILE = path.join(DATA_DIR, 'dashboard-login-guard.json');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function hashDashboardPassword(pw) {
  const salt = require('crypto').randomBytes(16).toString('hex');
  return `${salt}$${require('crypto').scryptSync(pw, salt, 32).toString('hex')}`;
}
function loadPasswordHash() {
  try {
    const t = fs.readFileSync(PASSWORD_HASH_FILE, 'utf8').trim();
    if (/^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  // One-time seed from env (set it, restart, unset it). Never logged.
  const pw = process.env.DASHBOARD_PASSWORD || '';
  if (pw.length >= 8) {
    const h = hashDashboardPassword(pw);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PASSWORD_HASH_FILE, h + '\n', { mode: 0o600 });
      console.log('dashboard password hash seeded at ' + PASSWORD_HASH_FILE);
      return h;
    } catch (e) { console.error('password seed failed', e); }
  }
  console.error('dashboard password NOT set - set DASHBOARD_PASSWORD once or write ' + PASSWORD_HASH_FILE);
  return '';
}
function verifyDashboardPassword(pw, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 2 || !pw) return false;
  const cand = require('crypto').scryptSync(pw, parts[0], 32);
  const want = Buffer.from(parts[1], 'hex');
  return cand.length === want.length && require('crypto').timingSafeEqual(cand, want);
}
let DASH_PASSWORD_HASH = loadPasswordHash();

function readJsonFile(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJsonFile(p, v) { try { fs.writeFileSync(p, JSON.stringify(v), { mode: 0o600 }); } catch (e) { console.error(e); } }
function clientIp(req) {
  // Behind Cloudflare: CF-Connecting-IP is set by the edge; otherwise use the LAST xff hop
  // (the one our own proxy appended), never the client-controlled first entry.
  const cf = (req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const hops = (req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return hops[hops.length - 1] || req.socket.remoteAddress || 'unknown';
}
function sessionTokenFrom(req) {
  const m = /(?:^|;\s*)mch_session=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const sessions = readJsonFile(SESSIONS_FILE, {});
  const exp = sessions[m[1]];
  if (!exp) return null;
  if (Date.now() > exp) { delete sessions[m[1]]; writeJsonFile(SESSIONS_FILE, sessions); return null; }
  return m[1];
}

function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && require('crypto').timingSafeEqual(x, y); }
const PUBLIC_API = new Set(['/api/health', '/api/status', '/api/auth-check']);

app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const guard = readJsonFile(LOGIN_GUARD_FILE, {});
  for (const [k, v] of Object.entries(guard)) if (!v || (v.locked_until || 0) < now - LOGIN_LOCKOUT_MS) { if (!v || !v.fails) delete guard[k]; }
  const g = guard[ip] || { fails: 0, locked_until: 0 };
  if (g.locked_until && now < g.locked_until) {
    return res.status(429).json({ error: 'locked out', retry_after_sec: Math.ceil((g.locked_until - now) / 1000) });
  }
  // Reserve the attempt BEFORE verifying (no await between read and write), so parallel
  // guesses cannot all pass the lock check. Success clears it.
  g.fails = (g.fails || 0) + 1;
  if (g.fails >= MAX_LOGIN_FAILS) { g.locked_until = now + LOGIN_LOCKOUT_MS; g.fails = 0; console.warn(`dashboard login: ${ip} LOCKED OUT for 15m`); }
  guard[ip] = g;
  const keys = Object.keys(guard);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete guard[k];
  writeJsonFile(LOGIN_GUARD_FILE, guard);
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  const okPw = !!DASH_PASSWORD_HASH && verifyDashboardPassword(pw, DASH_PASSWORD_HASH);
  if (!okPw) {
    await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
    return bad(res, 401, 'wrong password');
  }
  const g2 = readJsonFile(LOGIN_GUARD_FILE, {});
  delete g2[ip];
  writeJsonFile(LOGIN_GUARD_FILE, g2);
  const token = require('crypto').randomBytes(32).toString('hex');
  const sessions = readJsonFile(SESSIONS_FILE, {});
  for (const [t, exp] of Object.entries(sessions)) if (now > exp) delete sessions[t];
  sessions[token] = now + SESSION_TTL_MS;
  writeJsonFile(SESSIONS_FILE, sessions);
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mch_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
  console.log(`dashboard login: ${ip} logged in`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const tok = sessionTokenFrom(req);
  if (tok) { const s = readJsonFile(SESSIONS_FILE, {}); delete s[tok]; writeJsonFile(SESSIONS_FILE, s); }
  res.setHeader('Set-Cookie', 'mch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// First-run setup only. Keep a fresh instance private until it is configured.
app.post('/api/setup', (req, res) => {
  if (DASH_PASSWORD_HASH || fs.existsSync(PASSWORD_HASH_FILE))
    return bad(res, 403, 'already configured');
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (pw.length < 12 || pw.length > 256)
    return bad(res, 400, 'Use a password between 12 and 256 characters');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const hash = hashDashboardPassword(pw);
    fs.writeFileSync(PASSWORD_HASH_FILE, hash + '\n', { mode: 0o600, flag: 'wx' });
    DASH_PASSWORD_HASH = hash;
    console.log('dashboard password configured');
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'EEXIST') return bad(res, 403, 'already configured');
    console.error('dashboard setup failed', e.code);
    bad(res, 500, 'Could not save password');
  }
});

app.get('/api/auth-check', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authed: !!sessionTokenFrom(req), configured: !!DASH_PASSWORD_HASH });
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET' && PUBLIC_API.has(req.path)) return next();
  if (req.path === '/api/login' || req.path === '/api/logout') return next();
  if (sessionTokenFrom(req)) return next();
  // service-to-service only: pulse's revival trigger uses the shared token
  if (req.path === '/api/revive-key' && DASH_TOKEN && safeEq(req.headers.authorization || '', `Bearer ${DASH_TOKEN}`)) return next();
  bad(res, 401, 'auth required');
});

// --- helpers ---
function tail(file, lines = 200) {
  try {
    const d = fs.readFileSync(file, 'utf8');
    return d.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// Detect HeadlessMC/Minecraft process via /proc (graceful off-Linux).
function isRunning() {
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmd.includes('headlessmc') || cmd.includes('.minecraft')) return true;
      } catch {}
    }
  } catch {}
  return false;
}

function appendCmd(line) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(path.join(LOGS, 'dashboard-commands.log'), line + '\n');
}

// Best-effort live command into the running game (HMC reads hmc-cmd.log via stdin).
function hmc(line) {
  try {
    fs.appendFileSync(HMC_CMD, line + '\n');
  } catch (e) {
    console.error(e);
  }
}

function bad(res, status, error) {
  res.status(status).json({ error });
}

// Parse host:port from server.target; fall back to default server.
function readTarget() {
  try {
    const raw = fs.readFileSync(SERVER_TARGET, 'utf8').trim();
    const m = raw.match(/^([A-Za-z0-9.-]+):(\d+)$/);
    if (m) return { host: m[1], port: Number(m[2]), target: raw };
  } catch {}
  return { host: 'donutsmp.net', port: 25565, target: 'donutsmp.net:25565' };
}

// --- routes ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mc: '1.21.11', port: PORT });
});

app.get('/api/status', (_req, res) => {
  let loginPending = true;
  try {
    if (fs.existsSync(LOGIN_DONE)) loginPending = false;
  } catch {}
  res.json({
    running: isRunning(),
    loginPending,
    version: VERSION,
  });
});

// Timestamp boundary for this dashboard process; join boundaries come from the game log.
const transitionAt = Date.now();
// What the game is observably doing. A stopped process always wins over old log lines.
// The WHOLE latest.log is scanned (a join marker can scroll out of any tail window) and the
// result is cached by mtime+size. joinIdx = line index of the last join marker: telemetry and
// script heartbeats only count when they appear AFTER it, which binds them to the current
// join/world even across a spontaneous Disconnecting -> Joined (no reuse of an old world's data).
let gameCache = { key: '', info: null };
function gameInfo() {
  if (!isRunning()) return { game: 'stopped', lines: [], joinIdx: -1 };
  const file = path.join(GDIR, 'logs', 'latest.log');
  let st;
  try { st = fs.statSync(file); } catch { return { game: 'menu', lines: [], joinIdx: -1 }; }
  const key = `${st.mtimeMs}:${st.size}`;
  if (gameCache.key === key && gameCache.info) return gameCache.info;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch {}
  let game = 'menu', joinIdx = -1;
  lines.forEach((l, i) => {
    if (/logged in with entity id|Joined|Loaded \d+ advancements/.test(l)) { game = 'in-world'; joinIdx = i; }
    else if (/Connecting to /.test(l)) { game = 'connecting'; joinIdx = -1; }
    else if (/Disconnecting|Stopping worker threads|Stopping!/.test(l)) { game = 'menu'; joinIdx = -1; }
  });
  gameCache = { key, info: { game, lines, joinIdx } };
  return gameCache.info;
}
function observedGame() { return gameInfo().game; }
// Last JSON payload for `marker` that appears after the current join boundary.
// null = none after the join, undefined = present but not parseable.
function currentJoinJson(info, marker, accept) {
  for (let i = info.lines.length - 1; i > info.joinIdx; i--) {
    const l = info.lines[i];
    const at = l.indexOf(marker + ' ');
    if (at < 0) continue;
    let o; try { o = JSON.parse(l.slice(at + marker.length + 1).trim()); } catch { return undefined; }
    if (accept && !accept(o)) continue;
    return o;
  }
  return null;
}

app.get('/api/login-code', (_req, res) => {
  if (fs.existsSync(LOGIN_DONE)) return bad(res, 404, 'Already logged in');
  const raw = tail(path.join(LOGS, 'login.log'), 500);
  const uri = raw.match(/https?:\/\/[^\s]*microsoft\.com\/link[^\s]*/i);
  const code = raw.match(/\b[A-Z0-9]{8}\b/);
  if (!uri || !code) return bad(res, 404, 'No pending login code');
  res.json({
    code: code[0],
    url: uri[0].replace(/[?&]otc=.*$/i, ''), // verification_uri
    fullUrl: `${uri[0].replace(/[?&]otc=.*$/i, '')}?otc=${code[0]}`,
    raw: raw.trim().split('\n').slice(-1)[0],
  });
});

app.post('/api/chat', (req, res) => {
  const msg = typeof req.body?.msg === 'string' ? req.body.msg.trim() : '';
  if (!msg) return bad(res, 400, 'msg required');
  if (msg.length > 256) return bad(res, 400, 'msg max 256 chars');
  if (/[\r\n\0]/.test(msg)) return bad(res, 400, 'msg must be one line');
  appendCmd(`msg ${msg}`);
  hmc(`msg ${msg}`);
  res.json({ ok: true });
});

const SCRIPT_ALLOW = new Set(['afk', 'grinder', 'telemetry']);
const AFK_GROUP = ['afk', 'grinder']; // only one AFK-style script autoruns at a time
app.post('/api/script', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const action = req.body?.action === undefined ? 'start' : req.body.action;
  if (action !== 'start' && action !== 'stop')
    return bad(res, 400, 'action must be start|stop');
  if (!SCRIPT_ALLOW.has(name)) return bad(res, 400, 'script not allowed');

  const cfgPath = path.join(GDIR, 'minescript', 'config.txt');
  const autorunLine = `autorun[*]=\\${name}`;
  const legacyLine = `autorun[*]=${name}`;

  if (action === 'start') {
    if (!fs.existsSync(path.join(GDIR, 'minescript', `${name}.py`)))
      return bad(res, 404, 'script not installed');

    // Autorun: jobs end on disconnect, so re-fire on every join via minescript config.
    try {
      if (fs.existsSync(cfgPath)) {
        const txt = fs.readFileSync(cfgPath, 'utf8');
        if (!txt.split('\n').includes(autorunLine)) {
          const sep = txt && !txt.endsWith('\n') ? '\n' : '';
          fs.appendFileSync(cfgPath, sep + autorunLine + '\n');
        }
      } else {
        fs.writeFileSync(cfgPath, `python="/usr/bin/python3"\n${autorunLine}\n`);
      }
    } catch (e) {
      console.error(e);
      return bad(res, 500, 'Failed to write minescript config');
    }

    // AFK-style scripts are mutually exclusive: drop the others' autorun lines.
    if (AFK_GROUP.includes(name)) {
      try {
        const cur = fs.readFileSync(cfgPath, 'utf8').split('\n');
        const keep = cur.filter((l) => !AFK_GROUP.some((o) => o !== name && (l === `autorun[*]=\\${o}` || l === `autorun[*]=${o}`)));
        fs.writeFileSync(cfgPath, keep.join('\n'));
      } catch (e) { console.error(e); }
    }
    appendCmd(`run ${name}`);
    hmc('msg \\' + name);

    // Rejoin only toward an EXPLICIT server.target (never the donutsmp.net default), one pending timer.
    let explicit = null;
    try { const m = fs.readFileSync(SERVER_TARGET, 'utf8').trim().match(/^([A-Za-z0-9.-]+):(\d+)$/); if (m) explicit = { host: m[1], port: Number(m[2]), target: m[0] }; } catch {}
    if (!explicit) return res.json({ ok: true, script: name, action: 'start', rejoin: false, note: 'No server chosen yet; the script runs on your next join.' });
    hmc('disconnect');
    if (global.__rejoinTimer) clearTimeout(global.__rejoinTimer);
    global.__rejoinTimer = setTimeout(() => { global.__rejoinTimer = null; hmc(`connect ${explicit.host} ${explicit.port}`); }, 8000);
    return res.json({ ok: true, script: name, action: 'start', target: explicit.target });
  }

  // stop: drop the autorun line, then disconnect so the running job dies.
  try {
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8');
      const lines = txt.split('\n').filter((l) => l !== autorunLine && l !== legacyLine);
      fs.writeFileSync(cfgPath, lines.join('\n'));
    }
  } catch (e) {
    console.error(e);
    return bad(res, 500, 'Failed to write minescript config');
  }
  hmc('disconnect');
  return res.json({ ok: true, script: name, action: 'stop' });
});

const MOVE_ALLOW = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'stop']);
const MOVE_KEY = {
  forward: 'key w --duration 600',
  back: 'key s --duration 600',
  left: 'key a --duration 600',
  right: 'key d --duration 600',
  jump: 'key space --duration 400',
  sneak: 'key shift --duration 800',
  stop: ['key -release w', 'key -release a', 'key -release s', 'key -release d', 'key -release space', 'key -release shift'],
};
app.post('/api/move', (req, res) => {
  const { dir, yaw, pitch } = req.body || {};
  if (typeof dir === 'string' && dir.trim()) {
    const d = dir.trim();
    if (!MOVE_ALLOW.has(d))
      return bad(res, 400, 'dir must be forward|back|left|right|jump|sneak|stop');
    appendCmd(`move ${d}`);
    const k = MOVE_KEY[d];
    if (Array.isArray(k)) k.forEach((l) => hmc(l));
    else hmc(k);
    return res.json({ ok: true, dir: d });
  }
  if (Number.isFinite(Number(yaw)) && Number.isFinite(Number(pitch))) {
    appendCmd(`orient ${Number(yaw)} ${Number(pitch)}`);
    // No hmc mapping for look: yaw/pitch needs a running supervisor script to stream turns.
    return res.json({ ok: true, yaw: Number(yaw), pitch: Number(pitch) });
  }
  return bad(res, 400, 'Provide dir (forward|back|left|right|jump|sneak|stop) or yaw+pitch');
});

const PRESS_ALLOW = new Set(['sneak', 'attack', 'use']);
// NOTE: mouse0/mouse1 names are unverified against hmc-specifics 2.4.0 — the game console
// will show a rejection if the names are wrong.
const PRESS_KEY = {
  sneak: 'key shift --duration 800',
  attack: 'key mouse0 --duration 500',
  use: 'key mouse1 --duration 500',
};
app.post('/api/press', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!PRESS_ALLOW.has(key)) return bad(res, 400, 'key must be sneak|attack|use');
  appendCmd(`press ${key}`);
  hmc(PRESS_KEY[key]);
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 2000);
  res.json({
    game: tail(path.join(GDIR, 'logs', 'latest.log'), lines),
    entrypoint: tail(path.join(LOGS, 'entrypoint.log'), lines),
    dashboard: tail(path.join(LOGS, 'dashboard.log'), lines),
  });
});

app.post('/api/connect', (req, res) => {
  const host = typeof req.body?.host === 'string' ? req.body.host.trim() : '';
  const rawPort = req.body?.port;
  const port = rawPort === undefined || rawPort === '' ? 25565 : Number(rawPort);
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || host.length > 253)
    return bad(res, 400, 'invalid host');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return bad(res, 400, 'invalid port');
  const target = `${host}:${port}`;
  try {
    fs.writeFileSync(SERVER_TARGET, target);
  } catch (e) {
    console.error(e);
    return bad(res, 500, 'Failed to write server.target');
  }
  hmc(`connect ${host} ${port}`);
  res.json({ ok: true, target });
});

app.post('/api/disconnect', (_req, res) => {
  hmc('disconnect');
  res.json({ ok: true });
});

// Telemetry contract v2 (scripts/telemetry.py): one JSON object per ~2s with
// {v:2, ts (epoch s), session, seq, x,y,z,yaw,pitch,health (number|null), inventory (array|null)}.
// Unknown values are null, never invented. The reader returns an explicit status:
// live | stale | unavailable (+ reason), so old/previous-session samples never look current.
const TELEMETRY_FRESH_SEC = 10;
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
function validTelemetry(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.v !== 2 || typeof o.ts !== 'number' || !Number.isFinite(o.ts) || typeof o.session !== 'string' || !o.session) return false;
  for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'health']) if (!isNumOrNull(o[k])) return false;
  if (o.inventory !== null) {
    if (!Array.isArray(o.inventory) || o.inventory.length > 64) return false;
    for (const i of o.inventory) if (!i || typeof i.name !== 'string' || typeof i.count !== 'number' || !Number.isFinite(i.count)) return false;
  }
  return true;
}
app.get('/api/telemetry', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const none = (reason, extra) => res.json({ status: 'unavailable', reason, ...(extra || {}) });
  const info = gameInfo();
  if (info.game !== 'in-world') return none('not-joined', { game: info.game });
  const o = currentJoinJson(info, 'TELEMETRY');
  if (o === null) return none('no-sample-since-join');
  if (o === undefined || !validTelemetry(o)) return none('invalid-sample');
  const age = Date.now() / 1000 - o.ts;
  if (age < -2) return none('future-timestamp');
  if (o.ts * 1000 < transitionAt) return none('previous-session', { ageSec: Math.round(age) });
  const body = { status: age > TELEMETRY_FRESH_SEC ? 'stale' : 'live', ageSec: Math.max(0, Math.round(age)), session: o.session, ts: o.ts };
  if (body.status === 'live') {
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'health']) body[k] = o[k];
    body.inventory = o.inventory === null ? null : o.inventory.slice(0, 12);
    body.missing = ['x', 'y', 'z', 'yaw', 'pitch', 'health', 'inventory'].filter((k) => body[k] === null);
    if (['x', 'y', 'z'].every((k) => body[k] === null)) { body.status = 'unavailable'; body.reason = 'no-player-data'; }
  } else {
    body.reason = 'sample-too-old';
  }
  res.json(body);
});


// --- DonutSMP API key revival (pulse self-heal loop) ---
const REVIVE_STATE_FILE = path.join(DATA_DIR, 'revive-state.json');
const MS_DIR = path.join(GDIR, 'minescript');
const APIKEY_REQ = path.join(MS_DIR, 'apikey_request.json');
const APIKEY_RES = path.join(MS_DIR, 'apikey_result.json');
const APIKEY_AUTORUN = 'autorun[*]=\\apikey';
const REVIVE_COOLDOWN_OK_MS = 4 * 3600 * 1000;   // after a successful capture
const REVIVE_COOLDOWN_FAIL_MS = 30 * 60 * 1000;  // after a failed attempt
const REVIVE_TIMEOUT_MS = 20 * 60 * 1000;

function readJsonSafe(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}
function writeReviveState(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(REVIVE_STATE_FILE, JSON.stringify(s)); } catch (e) { console.error(e); }
}
function reviveState() { return readJsonSafe(REVIVE_STATE_FILE, { in_progress: false }); }

function ensureApikeyAutorun(on) {
  const cfgPath = path.join(MS_DIR, 'config.txt');
  let txt = '';
  try { txt = fs.readFileSync(cfgPath, 'utf8'); } catch {}
  const has = txt.split('\n').includes(APIKEY_AUTORUN);
  if (on && !has) {
    const sep = txt && !txt.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(cfgPath, txt + sep + APIKEY_AUTORUN + '\n');
  } else if (!on && has) {
    fs.writeFileSync(cfgPath, txt.split('\n').filter((l) => l !== APIKEY_AUTORUN).join('\n'));
  }
}

function postCallback(url, payload, attempt) {
  const body = JSON.stringify(payload);
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const creq = mod.request({
    method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${DASH_TOKEN}` },
    timeout: 10000,
  }, (cres) => {
    console.log(`revive callback -> ${cres.statusCode} (attempt ${attempt})`);
    cres.resume();
    if (cres.statusCode >= 400 && attempt < 4) setTimeout(() => postCallback(url, payload, attempt + 1), 15000 * attempt);
  });
  creq.on('error', (e) => {
    console.error('revive callback error', e.message);
    if (attempt < 4) setTimeout(() => postCallback(url, payload, attempt + 1), 15000 * attempt);
  });
  creq.on('timeout', () => creq.destroy(new Error('timeout')));
  creq.write(body);
  creq.end();
}

let revivePoller = null;
function watchReviveResult(id, callbackUrl, startedAt) {
  if (revivePoller) clearInterval(revivePoller);
  revivePoller = setInterval(() => {
    const st = reviveState();
    if (!st.in_progress || st.id !== id) { clearInterval(revivePoller); revivePoller = null; return; }
    if (Date.now() - startedAt > REVIVE_TIMEOUT_MS) {
      clearInterval(revivePoller); revivePoller = null;
      ensureApikeyAutorun(false);
      writeReviveState({ ...st, in_progress: false, finished_at: Date.now(), last_result: { status: 'error', error: 'timeout waiting for in-game capture' } });
      postCallback(callbackUrl, { status: 'error', error: 'timeout waiting for in-game capture' }, 1);
      return;
    }
    const out = readJsonSafe(APIKEY_RES, null);
    if (!out || out.id !== id) return;
    clearInterval(revivePoller); revivePoller = null;
    ensureApikeyAutorun(false);
    try { fs.unlinkSync(APIKEY_RES); } catch {}
    writeReviveState({ ...st, in_progress: false, finished_at: Date.now(), last_result: { status: out.status, error: out.error || null, chat_tail: (out.chat || []).slice(-8) } });
    postCallback(callbackUrl, { status: out.status, key: out.key || null, error: out.error || null }, 1);
  }, 5000);
}

app.get('/api/revive-key', (_req, res) => {
  const st = reviveState();
  res.json({
    in_progress: !!st.in_progress,
    id: st.id || null,
    requested_at: st.requested_at || null,
    last_attempt_at: st.last_attempt_at || null,
    last_result: st.last_result || null,
    cooldown_ok_ms: REVIVE_COOLDOWN_OK_MS,
    cooldown_fail_ms: REVIVE_COOLDOWN_FAIL_MS,
  });
});

app.post('/api/revive-key', (req, res) => {
  const callbackUrl = typeof req.body?.callback_url === 'string' ? req.body.callback_url.trim() : '';
  let u;
  try { u = new URL(callbackUrl); } catch { return bad(res, 400, 'callback_url required'); }
  if (u.protocol !== 'http:' || !/^(172\.17\.0\.1|127\.0\.0\.1|localhost)$/.test(u.hostname))
    return bad(res, 400, 'callback_url must be internal');
  const st = reviveState();
  if (st.in_progress) return res.status(409).json({ error: 'revival already in progress', id: st.id });
  const now = Date.now();
  const cooldown = st.last_result && st.last_result.status === 'ok' ? REVIVE_COOLDOWN_OK_MS : REVIVE_COOLDOWN_FAIL_MS;
  if (st.last_attempt_at && now - st.last_attempt_at < cooldown)
    return res.status(429).json({ error: 'cooldown', retry_after_sec: Math.ceil((cooldown - (now - st.last_attempt_at)) / 1000) });
  if (!fs.existsSync(path.join(MS_DIR, 'apikey.py')))
    return bad(res, 500, 'apikey.py not installed');

  const id = require('crypto').randomBytes(8).toString('hex');
  try { fs.unlinkSync(APIKEY_RES); } catch {}
  try {
    fs.writeFileSync(APIKEY_REQ, JSON.stringify({ id, requested_at: Math.floor(now / 1000) }));
  } catch (e) { console.error(e); return bad(res, 500, 'failed to write request file'); }
  ensureApikeyAutorun(true);
  writeReviveState({ in_progress: true, id, requested_at: now, last_attempt_at: now, callback_url: callbackUrl });

  // Human-plausible reconnect: wait a bit like a person coming back, then rejoin.
  const { host, port, target } = readTarget();
  const preDelay = 20000 + Math.floor(Math.random() * 70000);
  appendCmd(`revive-key ${id} -> reconnect ${target} in ${Math.round(preDelay / 1000)}s`);
  setTimeout(() => {
    hmc('disconnect');
    setTimeout(() => hmc(`connect ${host} ${port}`), 8000 + Math.floor(Math.random() * 7000));
  }, preDelay);

  watchReviveResult(id, callbackUrl, now);
  res.status(202).json({ ok: true, id, target, eta_sec: Math.round(preDelay / 1000) + 300 });
});


// --- Session health + in-UI re-login (Microsoft device code) ---
const HMC_JAR = (() => {
  try {
    const f = fs.readdirSync('/headlessmc').filter((x) => /^headlessmc-launcher-wrapper.*\.jar$/.test(x)).sort()[0];
    return f ? path.join('/headlessmc', f) : '';
  } catch { return ''; }
})();
const LOGIN_LOG = path.join(LOGS, 'login.log');
let relogin = { state: 'idle', startedAt: 0, finishedAt: 0, error: null, proc: null };

function sessionInvalid() {
  const t = tail(path.join(GDIR, 'logs', 'latest.log'), 400);
  const lines = t.split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (/invalid session|401.*(profile|key ?pair)|InsufficientPrivileges|Failed to fetch profile key pair/i.test(l)) last = i; });
  if (last < 0) return false;
  // a later successful join clears it
  return !lines.slice(last + 1).some((l) => /Connecting to |Joined|Starting integrated|Loaded \d+ advancements|logged in with entity id/i.test(l));
}

app.get('/api/session', (_req, res) => {
  let code = null;
  if (relogin.state === 'waiting') {
    const raw = tail(LOGIN_LOG, 50);
    const uri = raw.match(/https?:\/\/[^\s]*microsoft\.com\/link[^\s]*/i);
    const c = uri && uri[0].match(/otc=([A-Z0-9]{6,10})/i);
    if (uri) {
      const base = uri[0].replace(/[?&]otc=.*$/i, '');
      code = { code: c ? c[1] : null, url: base, fullUrl: uri[0] };
    }
  }
  res.json({
    loginDone: fs.existsSync(LOGIN_DONE),
    invalid: sessionInvalid(),
    relogin: { state: relogin.state, startedAt: relogin.startedAt, finishedAt: relogin.finishedAt, error: relogin.error },
    code,
  });
});

app.post('/api/relogin', (_req, res) => {
  if (!HMC_JAR) return bad(res, 500, 'HeadlessMC launcher not found');
  if (relogin.state === 'waiting' || relogin.state === 'restarting') return res.json({ ok: true, state: relogin.state });
  const prevDone = fs.existsSync(LOGIN_DONE);
  try { fs.unlinkSync(LOGIN_DONE); } catch {}
  try { if (fs.existsSync(LOGIN_LOG)) fs.renameSync(LOGIN_LOG, LOGIN_LOG + '.old'); } catch {}
  let out;
  try { out = fs.openSync(LOGIN_LOG, 'w'); } catch (e) { return bad(res, 500, 'cannot open login log'); }
  const { spawn } = require('child_process');
  const p = spawn('java', ['-jar', HMC_JAR, '--command', 'login'], { cwd: HMC_HOME, stdio: ['ignore', out, out], detached: false });
  const mine = { state: 'waiting', startedAt: Date.now(), finishedAt: 0, error: null, proc: p, prevDone };
  relogin = mine;
  appendCmd('relogin started');
  const timer = setTimeout(() => { try { p.kill(); } catch {} }, 12 * 60 * 1000);
  p.on('exit', (code) => {
    clearTimeout(timer);
    if (relogin !== mine) return; // stale exit from a cancelled/replaced attempt
    const ok = code === 0 && /success/i.test(tail(LOGIN_LOG, 50));
    if (ok) {
      try { fs.writeFileSync(LOGIN_DONE, ''); } catch {}
      mine.state = 'restarting';
      mine.finishedAt = Date.now();
      appendCmd('relogin ok -> restarting client');
      // Kill the game JVM; the entrypoint loop relaunches it with the fresh session.
      exec("pkill -f '[l]aunch fabric' || true", () => {});
      setTimeout(() => { if (mine.state === 'restarting') mine.state = 'done'; }, 90 * 1000);
    } else {
      if (mine.prevDone && mine.state !== 'idle') { try { fs.writeFileSync(LOGIN_DONE, ''); } catch {} }
      if (mine.state !== 'idle') mine.state = 'failed';
      mine.finishedAt = Date.now();
      mine.error = code === null ? 'Timed out waiting for the code to be entered' : 'Login did not complete';
    }
    mine.proc = null;
  });
  res.json({ ok: true, state: 'waiting' });
});

app.post('/api/relogin/cancel', (_req, res) => {
  relogin.state = 'idle';
  if (relogin.proc) { try { relogin.proc.kill(); } catch {} }
  if (relogin.prevDone) { try { fs.writeFileSync(LOGIN_DONE, ''); } catch {} }
  res.json({ ok: true });
});

// --- AFK scripts: list with installed/active state ---
const SCRIPT_META = {
  afk: { title: 'DonutSMP AFK', desc: 'Looks straight up, sneaks, holds attack and use. Keeps the axe mining while you are away.' },
  grinder: { title: 'Mob grinder AFK', desc: 'Stands at an XP grinder and swings the sword only when the cooldown is full. Eats from the offhand when hungry.' },
};
// desired = configured to autorun on join. observed = running only with a fresh SCRIPTBEAT
// (with a session) logged after the current join; anything else is unknown, never "not running".
const SCRIPT_BEAT_FRESH_SEC = 25;
// Only 'running' is a positive observation. Everything else is unknown (no evidence either way).
function scriptObserved(name, info) {
  if (info.game !== 'in-world') return { observed: 'unknown', observedReason: info.game === 'stopped' ? 'game-stopped' : 'not-joined' };
  const o = currentJoinJson(info, 'SCRIPTBEAT', (x) => x && x.name === name);
  if (o === null) return { observed: 'unknown', observedReason: 'no-heartbeat-since-join' };
  if (o === undefined || typeof o.session !== 'string' || !o.session || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return { observed: 'unknown', observedReason: 'invalid-heartbeat' };
  const age = Date.now() / 1000 - o.ts;
  if (age > SCRIPT_BEAT_FRESH_SEC || age < -2 || o.ts * 1000 < transitionAt) return { observed: 'unknown', observedReason: 'stale-heartbeat' };
  return { observed: 'running', observedReason: null, ageSec: Math.max(0, Math.round(age)) };
}
app.get('/api/scripts', (_req, res) => {
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(GDIR, 'minescript', 'config.txt'), 'utf8'); } catch {}
  const lines = cfg.split('\n').map((l) => l.trim());
  const info = gameInfo();
  res.json({
    game: info.game,
    scripts: Object.keys(SCRIPT_META).map((name) => {
      const installed = fs.existsSync(path.join(GDIR, 'minescript', `${name}.py`));
      const desired = installed && (lines.includes(`autorun[*]=\\${name}`) || lines.includes(`autorun[*]=${name}`));
      const ob = scriptObserved(name, info);
      return { name, ...SCRIPT_META[name], installed, desired, ...ob, active: ob.observed === 'running' };
    }),
  });
});

// 404 + error handler
app.use((_req, res) => bad(res, 404, 'Not found'));
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return bad(res, 400, 'Invalid JSON');
  console.error(err);
  bad(res, 500, 'Internal error');
});

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));

