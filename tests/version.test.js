'use strict';
// Offline tests: no game launch, no network. Stubs only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}
async function withDashboard(home, fn) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DASH_DATA: home, HMC_HOME: home,
    MC_GDIR: home, MC_LOGS: home, DASHBOARD_PASSWORD: '' };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' });
  try {
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    const get = async p => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
    await fn(get);
  } finally {
    await new Promise(r => { child.once('exit', r); child.kill(); });
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ver-'));

test('version file present: health/status report it', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'launch-version'), 'fabric:26.3\n');
  await withDashboard(home, async get => {
    const h = await get('/api/health');
    const s = await get('/api/status');
    assert.equal(h.mc, 'fabric:26.3');
    assert.equal(s.version, 'fabric:26.3');
    assert.equal(s.versionSource, 'entrypoint-launch-file');
    assert.ok(s.versionWrittenAt);
  });
});

test('version file absent (standalone mode): reports unknown, never a hardcoded version', async () => {
  const home = tmp();
  await withDashboard(home, async get => {
    const h = await get('/api/health');
    const s = await get('/api/status');
    assert.equal(h.status, 'ok');
    assert.equal(h.mc, 'unknown');
    assert.equal(s.version, 'unknown');
    assert.equal(s.versionSource, 'none');
    assert.equal(s.versionWrittenAt, null);
    assert.ok(!JSON.stringify([h, s]).includes('1.21.11'));
  });
});

test('stale version file: still reported, with its write time and a not-proof note', async () => {
  const home = tmp();
  const f = path.join(home, 'launch-version');
  fs.writeFileSync(f, 'fabric:26.3\n');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(f, old, old);
  await withDashboard(home, async get => {
    const s = await get('/api/status');
    assert.equal(s.version, 'fabric:26.3');
    assert.equal(s.versionWrittenAt, old.toISOString());
    assert.match(s.versionNote, /may be stale/);
  });
});

// Extract ensure_version/version_dir from entrypoint.sh and run with stubbed hmc/log.
function runEnsure(home, ver, makeDir) {
  const src = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
  const vd = src.match(/^version_dir\(\) .*$/m)[0];
  const fn = src.match(/# BEGIN ensure_version\n([\s\S]*?)# END ensure_version/)[1];
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  if (makeDir) fs.mkdirSync(path.join(home, 'versions', makeDir), { recursive: true });
  const script = `HMC_HOME="${home}"\nlog(){ echo "LOG $*"; }\nhmc(){ echo "STUB-HMC $*"; }\n${vd}\n${fn}\nensure_version "${ver}"\n`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout;
}
const VER = (fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8').match(/^VER="([^"]+)"/m) || [])[1];

test('current VER is fabric:26.3 (default unchanged)', () => assert.equal(VER, 'fabric:26.3'));

test('dir exists for current version -> skip download', () => {
  const out = runEnsure(tmp(), VER, 'fabric-26.3');
  assert.match(out, /already downloaded/);
  assert.doesNotMatch(out, /STUB-HMC/);
});

test('dir absent -> download current version', () => {
  const out = runEnsure(tmp(), VER);
  assert.match(out, /STUB-HMC download fabric:26\.3/);
});

test('old fabric-1.21.11 dir does NOT suppress the 26.3 download', () => {
  const out = runEnsure(tmp(), VER, 'fabric-1.21.11');
  assert.match(out, /STUB-HMC download fabric:26\.3/);
});
