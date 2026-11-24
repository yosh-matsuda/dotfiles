import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer, request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeVersion, control, HERE, running } from './runtime.mjs';
import { peerVerdict, pingAction, removeStale, socketOwners } from './server.mjs';
import { createStore } from './public/store.mjs';
import { createSources } from './sources.mjs';

const CLI = join(HERE, 'cli.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listening = (server, ...args) => new Promise((resolve) => server.listen(...args, resolve));
const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local, remote, st, uid) => `   0: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000 ${uid}        0 1 1`;
const CLIENT = { address: '127.0.0.1', port: 50000 };
const SERVER = { address: '127.0.0.1', port: 7421 };

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot-viz-test-'));
  const run = join(root, 'run');
  await mkdir(run, { mode: 0o700 });
  await mkdir(join(root, 'home', 'session-state'), { recursive: true });
  const dir = join(run, 'copilot-viz');
  const sock = join(dir, 'control.sock');
  t.after(async () => {
    await control(sock, 'POST', '/stop').catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { env: { ...process.env, XDG_RUNTIME_DIR: run, COPILOT_HOME: join(root, 'home') }, dir, sock };
}

function cli(env, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 25_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function serve(env, ...args) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  return { child, exited: once(child, 'exit') };
}

async function serverStatus(sock) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const st = (await control(sock, 'GET', '/status').catch(() => null))?.body;
    if (st?.port) return st;
    if (Date.now() > deadline) throw new Error('the server did not start');
    await sleep(50);
  }
}

function get(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function firstEvent(port, token) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/stream?token=${encodeURIComponent(token)}`, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        const m = /^data: (.*)\n\n/m.exec(text);
        if (!m) return;
        req.destroy();
        resolve({ retry: text.startsWith('retry: 3000\n'), msg: JSON.parse(m[1]) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// A stream that stays open, and the name that its first message gives it.
function openStream(port, token) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/api/stream?token=${encodeURIComponent(token)}`, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      const onData = (chunk) => {
        text += chunk;
        const m = /^data: (.*)\n\n/m.exec(text);
        if (!m) return;
        res.off('data', onData);
        res.resume();
        resolve({ viewer: JSON.parse(m[1]).viewer, close: () => req.destroy() });
      };
      res.on('data', onData);
    });
    req.on('error', reject);
    req.end();
  });
}

// A remote host `lab` whose ssh is a shim on PATH that runs the worker on a local directory, so
// no configured or real SSH host is contacted. Both hosts have a session `same`.
async function labRemote(env) {
  const home = env.COPILOT_HOME;
  const remoteHome = join(home, 'remote-home');
  const bin = join(home, 'bin');
  const pidFile = join(home, 'worker.pid');
  await mkdir(bin);
  for (const [root, result] of [[home, 'local output'], [remoteHome, 'remote output']]) {
    const dir = join(root, 'session-state', 'same');
    await mkdir(dir, { recursive: true });
    const event = (type, data = {}) => JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    await writeFile(join(dir, 'events.jsonl'), [
      event('session.start'),
      event('tool.execution_start', { toolCallId: 'C', toolName: 'bash', arguments: { command: 'pwd' } }),
      event('tool.execution_complete', { toolCallId: 'C', success: true, result: { content: result } }),
    ].join('\n') + '\n');
  }
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec '${process.execPath}' '${join(HERE, 'worker.mjs')}' --home '${remoteHome}' --since 86400000\n`, { mode: 0o700 });
  env.PATH = `${bin}:${env.PATH}`;
  const config = join(home, 'copilot-viz.json');
  await writeFile(config, JSON.stringify({ version: 1, remotes: [{ host: 'lab' }] }));
  return { config, pidFile };
}

// Pairs with the server of this socket, as a page does.
async function paired(sock) {
  const st = await serverStatus(sock);
  const launch = (await control(sock, 'POST', '/launch')).body.launch;
  const code = new URL(launch).searchParams.get('code');
  const r = await get(st.port, '/api/pair', {
    method: 'POST', headers: { Origin: `http://127.0.0.1:${st.port}` }, body: JSON.stringify({ code }),
  });
  const { token } = r.json();
  const headers = { Authorization: `Bearer ${token}` };
  const state = async () => (await get(st.port, '/api/state', { headers })).json();
  async function stateWhen(predicate) {
    const until = Date.now() + 5000;
    for (;;) {
      const s = await state();
      if (predicate(s)) return s;
      if (Date.now() > until) throw new Error('Timed out waiting for the remote state.');
      await sleep(15);
    }
  }
  return { st, token, headers, state, stateWhen };
}

test('finds the owners of the client end in the socket tables', () => {
  const tcp = [
    HEAD,
    row('0100007F:C350', '0100007F:1CFD', '01', 1000),
    row('0100007F:1CFD', '0100007F:C350', '01', 1001),
    row('0100007F:C350', '0100007F:1CFD', '06', 0),
  ].join('\n');
  const tcp6 = [HEAD, row('0000000000000000FFFF00000100007F:C350', '0000000000000000FFFF00000100007F:1CFD', '01', 1002)].join('\n');
  assert.deepEqual(socketOwners([tcp, tcp6], CLIENT, SERVER, true), [1000, 1002]);
  assert.deepEqual(socketOwners([row('7F000001:C350', '7F000001:1CFD', '01', 1003)], CLIENT, SERVER, false), [1003]);
});

test('a socket table that could not be read may hold the client', () => {
  const mine = [HEAD, row('0100007F:C350', '0100007F:1CFD', '01', 1000)].join('\n');
  const failed = Object.assign(new Error('read failed'), { code: 'EIO' });
  const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const verdict = (tables, wsl) => peerVerdict(tables, CLIENT, SERVER, { uid: 1000, wsl, le: true });
  assert.equal(verdict([mine, failed], false), true);
  assert.equal(verdict([HEAD, HEAD], false), false);
  // Mirrored networking of WSL leaves no row, and a system without IPv6 has no tcp6.
  assert.equal(verdict([HEAD, HEAD], true), true);
  assert.equal(verdict([HEAD, missing], true), true);
  assert.equal(verdict([failed, HEAD], true), false);
  assert.equal(verdict([failed, failed], false), false);
  assert.equal(verdict([failed, failed], true), true);
});

test('drops a viewer that skipped a message and did not catch up for a minute', () => {
  const now = Date.now();
  const viewer = (stale, ago) => ({ stale, caughtUp: now - ago });
  assert.equal(pingAction(viewer(false, 0), 0, now), 'ping');
  assert.equal(pingAction(viewer(false, 10_000), 2 << 20, now), null);
  assert.equal(pingAction(viewer(false, 120_000), 2 << 20, now), 'drop');
  // Reading a part of the backlog is not catching up.
  assert.equal(pingAction(viewer(true, 10_000), 1000, now), null);
  assert.equal(pingAction(viewer(true, 120_000), 1000, now), 'drop');
});

test('removes a dead socket but links back one that replaced it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-viz-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sock = join(dir, 'control.sock');
  const ino = async (path) => (await lstat(path)).ino;
  // Both names stay, so that no new file gets either inode.
  await writeFile(join(dir, 'dead'), '');
  await writeFile(join(dir, 'live'), '');
  const dead = await ino(join(dir, 'dead'));
  await link(join(dir, 'dead'), sock);
  await removeStale(sock, dead);
  assert.equal(existsSync(sock), false);

  await link(join(dir, 'live'), sock);
  await removeStale(sock, dead);
  assert.equal(await ino(sock), await ino(join(dir, 'live')));
  assert.deepEqual((await readdir(dir)).sort(), ['control.sock', 'dead', 'live']);
  await removeStale(join(dir, 'none'), dead);
});

test('a zombie does not count as running', { skip: process.platform !== 'linux' }, async (t) => {
  // sleep 30 becomes the parent of sleep 0.2 and never collects it.
  const parent = spawn('sh', ['-c', 'sleep 0.2 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => parent.kill());
  const [out] = await once(parent.stdout, 'data');
  const pid = Number(String(out).trim());
  const deadline = Date.now() + 5000;
  while (!/\) Z/.test(await readFile(`/proc/${pid}/stat`, 'latin1'))) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not become a zombie`);
    await sleep(20);
  }
  assert.equal(running(pid), false);
  assert.equal(running(process.pid), true);
});

test('finds the user of a real connection', { skip: process.platform !== 'linux' }, async (t) => {
  const server = createServer();
  await listening(server, 0, '127.0.0.1');
  const client = connect(server.address().port, '127.0.0.1');
  const [accepted] = await once(server, 'connection');
  t.after(() => {
    client.destroy();
    accepted.destroy();
    server.close();
  });
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'latin1').catch(() => '')));
  const from = { address: accepted.remoteAddress, port: accepted.remotePort };
  const to = { address: accepted.localAddress, port: accepted.localPort };
  assert.deepEqual(socketOwners(tables, from, to), [process.getuid()]);
});

test('a control reply that ends early or never comes fails', { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-viz-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cut = createServer((s) => s.once('data', () => {
    s.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"pid":1');
    setTimeout(() => s.destroy(), 20);
  }));
  const silent = createServer(() => {});
  await listening(cut, join(dir, 'cut'));
  await listening(silent, join(dir, 'silent'));
  t.after(() => {
    cut.close();
    silent.close();
  });
  await assert.rejects(control(join(dir, 'cut'), 'GET', '/status'), /ended early|aborted/);
  await assert.rejects(control(join(dir, 'silent'), 'GET', '/status', 200), { code: 'ETIMEDOUT' });
  assert.equal(await control(join(dir, 'none'), 'GET', '/status'), null);
});

test('serves a paired viewer and stops only for its own PID', { timeout: 30_000 }, async (t) => {
  const { env, sock } = await sandbox(t);
  const a = serve(env);
  const st = await serverStatus(sock);
  assert.equal(st.pid, a.child.pid);

  const second = await cli(env, 'serve', '--port', '0');
  assert.match(second.stderr, /already running/);
  assert.equal((await serverStatus(sock)).pid, st.pid);

  const code = new URL((await control(sock, 'POST', '/launch')).body.launch).searchParams.get('code');
  const pair = (origin) => get(st.port, '/api/pair', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ code }) });
  assert.equal((await pair('http://evil.example')).status, 403);
  const paired = await pair(`http://127.0.0.1:${st.port}`);
  assert.equal(paired.status, 200);
  const { token } = paired.json();
  assert.equal((await pair(`http://127.0.0.1:${st.port}`)).status, 403);

  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await get(st.port, '/api/state')).status, 401);
  assert.equal((await get(st.port, '/api/state', { headers: { ...auth, Host: 'evil.example' } })).status, 403);
  const state = await get(st.port, '/api/state', { headers: auth });
  assert.equal(state.status, 200);
  assert.equal(state.json().type, 'snapshot');
  const first = await firstEvent(st.port, token);
  assert.equal(first.retry, true);
  assert.equal(first.msg.type, 'snapshot');

  assert.equal((await control(sock, 'POST', '/stop?pid=1')).status, 409);
  assert.equal((await control(sock, 'POST', `/stop?pid=${st.pid}`)).status, 200);
  await a.exited;
  assert.equal(existsSync(sock), false);

  // A new server has a new token.
  const b = serve(env);
  const st2 = await serverStatus(sock);
  assert.equal((await get(st2.port, '/api/state', { headers: auth })).status, 401);
  await control(sock, 'POST', `/stop?pid=${st2.pid}`);
  await b.exited;
});

test('takes over the socket that a dead server left', { timeout: 30_000 }, async (t) => {
  const { env, dir, sock } = await sandbox(t);
  await mkdir(dir, { mode: 0o700 });
  const dead = createServer();
  await listening(dead, join(dir, 'dead'));
  await link(join(dir, 'dead'), sock);
  await new Promise((resolve) => dead.close(resolve));
  assert.equal(existsSync(sock), true);

  const a = serve(env);
  assert.equal((await serverStatus(sock)).pid, a.child.pid);
  await control(sock, 'POST', `/stop?pid=${a.child.pid}`);
  await a.exited;
});

test('open keeps a server that took another port, and restarts it for other options', { timeout: 60_000 }, async (t) => {
  const { env, sock } = await sandbox(t);
  const busy = createServer();
  await listening(busy, 0, '127.0.0.1');
  t.after(() => busy.close());
  const port = String(busy.address().port);

  const first = await cli(env, 'open', '--port', port, '--no-open');
  assert.equal(first.code, 0, first.stderr);
  const st = (await control(sock, 'GET', '/status')).body;
  assert.notEqual(st.port, Number(port));
  assert.equal(st.idleExitMs, 600_000);
  assert.match(first.stdout, new RegExp(`^http://127\\.0\\.0\\.1:${st.port}/\\?code=[\\w-]+\\n$`));

  const again = await cli(env, 'open', '--port', port, '--no-open');
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /restarting/);
  assert.equal((await control(sock, 'GET', '/status')).body.pid, st.pid);

  const other = await cli(env, 'open', '--port', port, '--since', '2h', '--no-open');
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.stderr, /restarting the server for --since 2h/);
  const st2 = (await control(sock, 'GET', '/status')).body;
  assert.notEqual(st2.pid, st.pid);
  assert.equal(st2.sinceMs, 2 * 36e5);

  const zero = await cli(env, 'open', '--port', '0', '--no-open');
  assert.equal(zero.code, 0, zero.stderr);
  assert.match(zero.stderr, /restarting the server for --port 0/);
  assert.equal((await control(sock, 'GET', '/status')).body.requestedPort, 0);

  const home = join(env.COPILOT_HOME, 'another');
  const changed = await cli({ ...env, COPILOT_HOME: home }, 'open', '--no-open');
  assert.match(changed.stderr, /restarting the server for a different COPILOT_HOME/);
  assert.equal((await serverStatus(sock)).copilotHome, home);

  const stopped = await cli(env, 'stop');
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(existsSync(sock), false);
});

test('open asks again when the control connection closes before the reply', { timeout: 30_000 }, async (t) => {
  const { env, dir, sock } = await sandbox(t);
  await mkdir(dir, { mode: 0o700 });
  const st = { pid: process.pid, copilotHome: env.COPILOT_HOME, version: await codeVersion(), requestedPort: 7421, port: 1, sinceMs: 864e5 };
  let requests = 0;
  const fake = httpServer((req, res) => {
    if (requests++ === 0) return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(req.url === '/launch' ? { ...st, launch: 'http://127.0.0.1:1/?code=x' } : st));
  });
  await listening(fake, sock);
  t.after(() => fake.close());
  const r = await cli(env, 'open', '--no-open');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'http://127.0.0.1:1/?code=x\n');
  assert.ok(requests >= 3);
});

test('a paired local viewer receives remote sessions and routes details across reconnects', { timeout: 20_000 }, async (t) => {
  const { env, sock } = await sandbox(t);
  const { config, pidFile } = await labRemote(env);
  const server = serve(env);
  const { st, headers, stateWhen } = await paired(sock);
  let state = await stateWhen((s) => s.ready && s.sessions.length === 2);
  assert.deepEqual(state.sessions.map((s) => s.id).sort(), ['lab/same', 'same']);
  const remote = state.sessions.find((s) => s.id === 'lab/same');
  const detail = (sid, epoch) => get(st.port, `/api/call?sid=${encodeURIComponent(sid)}&id=C&epoch=${encodeURIComponent(epoch)}`, { headers });
  assert.equal((await detail(remote.id, remote.epoch)).json().preview, 'remote output');
  const local = state.sessions.find((s) => s.id === 'same');
  assert.equal((await detail(local.id, local.epoch)).json().preview, 'local output');

  process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGTERM');
  state = await stateWhen((s) => s.hosts.find((h) => h.id === 'ssh:lab').state === 'offline');
  assert.equal(state.sessions.find((s) => s.id === remote.id).stale, true);
  assert.equal((await detail(remote.id, remote.epoch)).status, 503);
  state = await stateWhen((s) => s.hosts.find((h) => h.id === 'ssh:lab').state === 'live');
  assert.notEqual(state.sessions.find((s) => s.id === remote.id).epoch, remote.epoch);
  assert.equal((await detail(remote.id, remote.epoch)).status, 409);

  await writeFile(config, '{invalid');
  assert.equal((await cli(env, 'open', '--no-open')).code, 1);
  assert.equal((await control(sock, 'GET', '/status')).body.pid, st.pid);
  await writeFile(config, JSON.stringify({ version: 1, remotes: [] }));
  const changed = await cli(env, 'open', '--no-open');
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stderr, /remote configuration changed/);
  await server.exited;
  assert.equal(running(Number(await readFile(pidFile, 'utf8'))), false);
  assert.deepEqual((await control(sock, 'GET', '/status')).body.remotes, []);
  assert.equal((await cli(env, 'stop')).code, 0);
});

test('remote hosts disconnect while no page is in view, and connect again when one is', { timeout: 30_000 }, async (t) => {
  const { env, sock } = await sandbox(t);
  const misuse = await cli(env, 'open', '--no-open', '--pause-remotes', '0');
  assert.equal(misuse.code, 1);
  assert.match(misuse.stderr, /--pause-remotes works only with serve/);
  const { pidFile } = await labRemote(env);
  serve(env, '--pause-remotes', '0.01');
  const { st, token, headers, state, stateWhen } = await paired(sock);
  const lab = (s) => s.hosts.find((h) => h.id === 'ssh:lab').state;
  const report = (viewer, visible, seq, auth = headers) => get(st.port, '/api/view', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, visible, seq }),
  });

  // No page at all counts as none in view.
  await stateWhen((x) => lab(x) === 'paused');

  const a = await openStream(st.port, token);
  const b = await openStream(st.port, token);
  t.after(() => { a.close(); b.close(); });
  assert.notEqual(a.viewer, b.viewer);
  assert.equal((await report(a.viewer, true, 1, {})).status, 401);
  assert.equal((await report('gone', true, 1)).status, 404);
  assert.equal((await report(a.viewer, 'yes', 1)).status, 400);
  assert.equal((await report(a.viewer, true, 1)).status, 200);
  await stateWhen((x) => lab(x) === 'live' && !x.sessions.find((y) => y.id === 'lab/same').stale);
  const worker = Number(await readFile(pidFile, 'utf8'));

  // One page in view keeps SSH open.
  await report(b.viewer, true, 1);
  await report(a.viewer, false, 2);
  await sleep(900);
  assert.equal(lab(await state()), 'live');
  await report(b.viewer, false, 2);
  const paused = await stateWhen((x) => lab(x) === 'paused');
  assert.equal(paused.sessions.find((x) => x.id === 'lab/same').stale, true);
  for (const until = Date.now() + 5000; running(worker);) {
    if (Date.now() > until) throw new Error('the paused worker kept running');
    await sleep(15);
  }
  let st2 = (await control(sock, 'GET', '/status')).body;
  assert.deepEqual([st2.clients, st2.visibleClients, st2.remotesPaused], [2, 0, true]);

  // A report older than the last one of its stream does not count.
  await report(b.viewer, true, 1);
  await sleep(300);
  assert.equal(lab(await state()), 'paused');

  // A page in view that closes leaves none.
  await report(b.viewer, true, 3);
  await stateWhen((x) => lab(x) === 'live');
  b.close();
  await stateWhen((x) => lab(x) === 'paused');
  st2 = (await control(sock, 'GET', '/status')).body;
  assert.deepEqual([st2.clients, st2.visibleClients], [1, 0]);
});

test('invalid numbers and options for other commands are rejected before contacting a server', async (t) => {
  const { env } = await sandbox(t);
  for (const args of [['open', '--port', ''], ['serve', '--idle-exit', 'Infinity'], ['serve', '--pause-remotes', ' '],
    ['open', '--since', '9'.repeat(310)], ['status', '--since', '1d'], ['stop', '--port', '0'], ['status', '--no-open']]) {
    const r = await cli(env, ...args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /bad --|does not work with/);
  }
});

test('stop waits for a server that closes the control connection without replying', async (t) => {
  const { env, dir, sock } = await sandbox(t);
  await mkdir(dir);
  const server = httpServer((req, res) => {
    if (req.url === '/status') return res.end(JSON.stringify({ pid: 2147483647 }));
    server.close();
    req.socket.destroy();
  });
  await listening(server, sock);
  const r = await cli(env, 'stop');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /stopped/);
});

test('a viewer receives valid local sessions alongside an invalid directory name', async (t) => {
  const { env, sock } = await sandbox(t);
  for (const id of ['valid', 'a'.repeat(201)]) {
    const dir = join(env.COPILOT_HOME, 'session-state', id);
    await mkdir(dir);
    await writeFile(join(dir, 'events.jsonl'), '');
  }
  serve(env);
  const { st, token, stateWhen } = await paired(sock);
  await stateWhen((s) => s.ready);
  assert.deepEqual((await firstEvent(st.port, token)).msg.sessions.map((s) => s.id), ['valid']);
});

test('browser entries try paths literally, quote URL placeholders, and stop on success', async (t) => {
  const { env, sock } = await sandbox(t);
  serve(env);
  await serverStatus(sock);
  const program = join(env.COPILOT_HOME, 'browser (test)');
  const record = join(env.COPILOT_HOME, 'args');
  await writeFile(program, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORD"\n', { mode: 0o700 });
  for (const entry of [program, ...['%s', "'%s'", '"%s"', ''].map((arg) => `"${program}" ${arg}`)]) {
    const r = await cli({ ...env, RECORD: record, BROWSER: `false:${entry}:false` }, 'open');
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /no browser opened/);
    assert.equal(await readFile(record, 'utf8'), r.stdout);
  }
  const r = await cli({ ...env, BROWSER: `sleep 3.2 #:${program}`, RECORD: record }, 'open');
  assert.doesNotMatch(r.stderr, /no browser opened/);
  assert.notEqual(await readFile(record, 'utf8'), r.stdout);
});

// Run the server in its own process because shutdown exits. A fixture can advance its clock
// or hold a socket-table read without changing timers or built-ins in the test runner.
function fixtureServer(t, env, prelude, options = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    ${prelude}
    const { startServer } = await import('./server.mjs');
    await startServer(${JSON.stringify({ port: 0, ...options })});
  `], { cwd: HERE, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume();
  t.after(() => child.kill('SIGKILL'));
  return child;
}
async function advance(child, ms) {
  const reply = once(child, 'message');
  child.send(ms);
  await reply;
}
const clock = `
  import { mock } from 'node:test';
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  process.on('message', (ms) => { mock.timers.tick(ms); process.send('ticked'); });
`;

test('pairing grants a fresh idle window to connect the stream', async (t) => {
  const { env, sock } = await sandbox(t);
  const child = fixtureServer(t, env, clock, { idleExitMs: 40_000 });
  const { port } = await serverStatus(sock);
  const code = new URL((await control(sock, 'POST', '/launch')).body.launch).searchParams.get('code');
  await advance(child, 59_000);
  const paired = await get(port, '/api/pair', { method: 'POST', headers: { Origin: `http://localhost:${port}` }, body: JSON.stringify({ code }) });
  assert.equal(paired.status, 200);
  await advance(child, 1000);
  assert.equal((await control(sock, 'GET', '/status'))?.body.clients, 0);
});

test('macOS opens an owner-only file and removes it on expiry or shutdown', async (t) => {
  const { env, sock, dir } = await sandbox(t);
  const darwin = "Object.defineProperty(process, 'platform', { value: 'darwin' });";
  delete env.BROWSER;
  delete env.WSL_DISTRO_NAME;
  delete env.WSL_INTEROP;
  const child = fixtureServer(t, env, `${darwin}\n${clock}`);
  await serverStatus(sock);
  const opener = join(env.COPILOT_HOME, 'open');
  const argv = join(env.COPILOT_HOME, 'argv');
  await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$ARGV"\n', { mode: 0o700 });
  const r = await cli({ ...env, ARGV: argv, PATH: `${env.COPILOT_HOME}:${env.PATH}`,
    NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(darwin).toString('base64')}` }, 'open');
  assert.equal(r.code, 0, r.stderr);
  const path = await readFile(argv, 'utf8');
  assert.equal(path.startsWith(`${dir}/`), true);
  assert.equal(path.includes(new URL(r.stdout.trim()).searchParams.get('code')), false);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.ok((await readFile(path, 'utf8')).includes(`location.replace(${JSON.stringify(r.stdout.trim())})`));
  await advance(child, 120_001);
  assert.equal(existsSync(path), false);
  const file = (await control(sock, 'POST', '/launch')).body.file;
  assert.ok(existsSync(file));
  const exit = once(child, 'exit');
  await control(sock, 'POST', '/stop');
  await exit;
  assert.equal(existsSync(file), false);
});

test('a stream closed during its socket-table read does not register a viewer', { skip: process.platform !== 'linux', timeout: 5000 }, async (t) => {
  const { env, sock } = await sandbox(t);
  const child = fixtureServer(t, env, `
    import os from 'node:os';
    import fs from 'node:fs/promises';
    import http from 'node:http';
    import { syncBuiltinESMExports } from 'node:module';
    os.release = () => 'microsoft';
    const create = http.createServer;
    const read = fs.readFile;
    let closed;
    http.createServer = (...args) => create(...args).prependListener('request', (req) => {
      if (req.url.startsWith('/api/stream')) closed = new Promise((r) => req.socket.once('close', r));
    });
    fs.readFile = async (path, ...args) => {
      if (!path.startsWith('/proc/net/tcp')) return read(path, ...args);
      if (closed) {
        if (path === '/proc/net/tcp') process.send('checking');
        await closed;
        if (path === '/proc/net/tcp') setImmediate(() => process.send('checked'));
      }
      return '';
    };
    syncBuiltinESMExports();
  `);
  const { st, token } = await paired(sock);
  const checking = once(child, 'message');
  const req = request({ host: '127.0.0.1', port: st.port, path: `/api/stream?token=${token}`, agent: false });
  req.on('error', () => {});
  req.end();
  await checking;
  const checked = once(child, 'message');
  req.destroy();
  await checked;
  assert.equal((await control(sock, 'GET', '/status')).body.clients, 0);
});

test('native Windows is rejected before the CLI tries the control socket', async (t) => {
  const { env } = await sandbox(t);
  const prelude = "Object.defineProperty(process, 'platform', { value: 'win32' });";
  const r = await cli({ ...env, NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(prelude).toString('base64')}` }, 'status');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /use WSL/);
});

test('a PID owned by another user does not keep waitGone waiting', (t) => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
  assert.equal(running(process.pid), false);
});

test('unreadable Linux socket tables deny requests and surface one warning in status', { skip: process.platform !== 'linux' }, async (t) => {
  const { env, sock } = await sandbox(t);
  const child = fixtureServer(t, env, `
    import os from 'node:os';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    os.release = () => 'Linux';
    const read = fs.readFile;
    fs.readFile = async (path, ...args) => {
      if (path.startsWith('/proc/net/tcp')) throw new Error('unreadable');
      return read(path, ...args);
    };
    syncBuiltinESMExports();
  `);
  let log = '';
  child.stderr.on('data', (b) => { log += b; });
  const { port } = await serverStatus(sock);
  for (let i = 0; i < 2; i++) {
    const r = await get(port, '/');
    assert.equal(r.status, 403);
    assert.match(r.json().error, /cannot verify the owner/);
  }
  assert.match((await cli(env, 'status')).stdout, /cannot verify the owner/);
  assert.equal(log.match(/cannot verify the owner/g)?.length, 1);
});

test('a malformed remote session does not block its neighbors or replace its last valid state', (t) => {
  let receive;
  const errors = [];
  const sources = createSources({
    remotes: [{ host: 'dev' }], onError: (e) => errors.push(e.message), onMessage() {},
    remoteFactory: (_, options) => { receive = options.onMessage; return { stop() {} }; },
  });
  t.after(() => sources.stop());
  const good = { id: 'one', epoch: 'a', meta: {}, agents: [], calls: [], shells: [], feed: [], activity: [] };
  const other = { ...good, id: 'two' };
  const bad = { ...other, activity: [null] };
  const send = (sessions, type = 'snapshot') => receive({ type, sessions, now: 100, ready: true });
  send([good, bad]);
  assert.deepEqual(sources.snapshot().sessions.map((s) => s.id), ['dev/one']);
  assert.ok(createStore().apply(sources.snapshot()));
  send([bad], 'delta');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dev.*two/);
  send([other], 'delta');
  const last = sources.snapshot().sessions[1];
  send([bad]);
  assert.deepEqual(sources.snapshot().sessions, [last]);
  assert.equal(errors.length, 2);
  assert.throws(() => receive({ type: 'delta', sessions: [good], now: NaN }), /Invalid sessions/);
  assert.throws(() => receive({ type: 'delta', sessions: [good], now: 100, removed: ['.'] }), /Invalid sessions/);
  assert.deepEqual(sources.snapshot().sessions, [last]);
});
