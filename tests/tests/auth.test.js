'use strict';
// Dashboard-only regression test. Never launches Minecraft or connects to a server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

test('first-run setup, login, persistence and overwrite protection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auth-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, PORT: String(port), DASH_DATA: root,
    HMC_HOME: root, MC_GDIR: root, MC_LOGS: root, DASHBOARD_PASSWORD: '' };
  let child;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('dashboard did not start');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  };
  const request = (route, body, cookie) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  // A generated test-only value. Never a real account or deployed credential.
  const password = require('node:crypto').randomBytes(24).toString('hex');
  try {
    await start();
    assert.deepEqual(await (await request('/api/auth-check')).json(), { authed: false, configured: false });
    assert.equal((await request('/api/logs')).status, 401);
    assert.equal((await request('/api/setup', { password: 'short' })).status, 400);
    assert.equal((await request('/api/setup', { password: 'x'.repeat(257) })).status, 400);
    assert.equal((await request('/api/setup', { password })).status, 200);
    assert.equal((await request('/api/auth-check')).headers.get('cache-control'), 'no-store');
    const stored = fs.readFileSync(path.join(root, 'dashboard-password.hash'), 'utf8');
    assert.ok(!stored.includes(password));
    assert.equal(fs.statSync(path.join(root, 'dashboard-password.hash')).mode & 0o777, 0o600);
    const login = await request('/api/login', { password });
    assert.equal(login.status, 200, 'setup must work without restart');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await (await request('/api/auth-check', undefined, cookie)).json(), { authed: true, configured: true });
    assert.equal((await request('/api/logs', undefined, cookie)).status, 200);
    assert.equal((await request('/api/setup', { password: 'different-password' })).status, 403);
    assert.equal(fs.readFileSync(path.join(root, 'dashboard-password.hash'), 'utf8'), stored);
    await stop();
    await start();
    assert.equal((await request('/api/login', { password })).status, 200);
    assert.equal((await request('/api/setup', { password })).status, 403);
    assert.equal((await request('/api/logout', {}, cookie)).status, 200);
    assert.equal((await request('/api/logs', undefined, cookie)).status, 401);
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
