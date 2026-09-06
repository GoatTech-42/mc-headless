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

const app = express();
app.use(express.json());

// Static frontend (dir may not exist yet).
const pub = path.join(__dirname, 'public');
if (fs.existsSync(pub)) app.use(express.static(pub));

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

// 404 + error handler
app.use((_req, res) => bad(res, 404, 'Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  bad(res, 500, 'Internal error');
});

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));
