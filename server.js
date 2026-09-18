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
if (fs.existsSync(pub)) app.use(express.static(pub));

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
  if (pw.length >= 4) {
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
const DASH_PASSWORD_HASH = loadPasswordHash();

function readJsonFile(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJsonFile(p, v) { try { fs.writeFileSync(p, JSON.stringify(v), { mode: 0o600 }); } catch (e) { console.error(e); } }
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
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

const PUBLIC_API = new Set(['/api/health', '/api/status', '/api/login-code', '/api/auth-check']);

app.post('/api/login', async (req, res) => {
  const ip = clientIp(req);
  const guard = readJsonFile(LOGIN_GUARD_FILE, {});
  const g = guard[ip] || { fails: 0, locked_until: 0 };
  const now = Date.now();
  if (g.locked_until && now < g.locked_until) {
    return res.status(429).json({ error: 'locked out', retry_after_sec: Math.ceil((g.locked_until - now) / 1000) });
  }
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!DASH_PASSWORD_HASH || !verifyDashboardPassword(pw, DASH_PASSWORD_HASH)) {
    await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700))); // slow + timing de-jitter
    g.fails = (g.fails || 0) + 1;
    if (g.fails >= MAX_LOGIN_FAILS) {
      g.locked_until = now + LOGIN_LOCKOUT_MS;
      g.fails = 0;
      console.warn(`dashboard login: ${ip} LOCKED OUT for 15m after ${MAX_LOGIN_FAILS} failed attempts`);
    } else {
      console.warn(`dashboard login: failed attempt ${g.fails}/${MAX_LOGIN_FAILS} from ${ip}`);
    }
    guard[ip] = g;
    writeJsonFile(LOGIN_GUARD_FILE, guard);
    return bad(res, 401, 'wrong password');
  }
  delete guard[ip];
  writeJsonFile(LOGIN_GUARD_FILE, guard);
  const token = require('crypto').randomBytes(32).toString('hex');
  const sessions = readJsonFile(SESSIONS_FILE, {});
  for (const [t, exp] of Object.entries(sessions)) if (now > exp) delete sessions[t];
  sessions[token] = now + SESSION_TTL_MS;
  writeJsonFile(SESSIONS_FILE, sessions);
  res.setHeader('Set-Cookie', `mch_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  console.log(`dashboard login: ${ip} logged in`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const tok = sessionTokenFrom(req);
  if (tok) { const s = readJsonFile(SESSIONS_FILE, {}); delete s[tok]; writeJsonFile(SESSIONS_FILE, s); }
  res.setHeader('Set-Cookie', 'mch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth-check', (req, res) => res.json({ authed: !!sessionTokenFrom(req) }));

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET' && PUBLIC_API.has(req.path)) return next();
  if (req.path === '/api/login' || req.path === '/api/logout') return next();
  if (sessionTokenFrom(req)) return next();
  // service-to-service only: pulse's revival trigger uses the shared token
  if (req.path === '/api/revive-key' && DASH_TOKEN && (req.headers.authorization || '') === `Bearer ${DASH_TOKEN}`) return next();
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
    log: tail(path.join(LOGS, 'entrypoint.log'), 30),
  });
});

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
  appendCmd(`msg ${msg}`);
  hmc(`msg ${msg}`);
  res.json({ ok: true });
});

const SCRIPT_ALLOW = new Set(['afk', 'telemetry']);
app.post('/api/script', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const action = req.body?.action === undefined ? 'start' : req.body.action;
  if (action !== 'start' && action !== 'stop')
    return bad(res, 400, 'action must be start|stop');
  if (!SCRIPT_ALLOW.has(name)) return bad(res, 400, 'script not allowed');

  const cfgPath = path.join(GDIR, 'minescript', 'config.txt');
  const autorunLine = `autorun[*]=${name}`;

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

    appendCmd(`run ${name}`);
    hmc('msg \\' + name);

    // Rejoin now so autorun takes effect immediately (chat-send is broken on 1.21.11).
    const { host, port, target } = readTarget();
    hmc('disconnect');
    setTimeout(() => hmc(`connect ${host} ${port}`), 8000);
    return res.json({ ok: true, script: name, action: 'start', target });
  }

  // stop: drop the autorun line, then disconnect so the running job dies.
  try {
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8');
      const lines = txt.split('\n').filter((l) => l !== autorunLine);
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

app.get('/api/telemetry', (_req, res) => {
  let logText = '';
  try {
    logText = fs.readFileSync(path.join(GDIR, 'logs', 'latest.log'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT')
      return bad(res, 404, 'No telemetry yet — join a world and run telemetry script');
    console.error(e);
    return bad(res, 500, 'Failed to read latest.log');
  }
  const last = logText.split('\n').filter(Boolean).slice(-200).reverse()
    .find((l) => l.includes('TELEMETRY '));
  if (!last)
    return bad(res, 404, 'No telemetry yet — join a world and run telemetry script');
  const json = last.slice(last.indexOf('TELEMETRY ') + 'TELEMETRY '.length).trim();
  try {
    res.json(JSON.parse(json));
  } catch (e) {
    console.error(e);
    bad(res, 500, 'Failed to parse telemetry');
  }
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

// 404 + error handler
app.use((_req, res) => bad(res, 404, 'Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  bad(res, 500, 'Internal error');
});

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));
