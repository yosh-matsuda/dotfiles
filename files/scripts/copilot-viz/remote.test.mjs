import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createModel } from './model.mjs';
import { createRemote, loadRemotes, sshArgs } from './remote.mjs';
import { HERE } from './runtime.mjs';
import { createSources } from './sources.mjs';
import { createStore, isLive, sessionNow, sortSessions } from './public/store.mjs';
import { encodeMessage, MAX_MESSAGE, PROTOCOL, readMessages } from './wire.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the worker.');
    await sleep(10);
  }
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-viz-remote-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function session(id = 'same') {
  const model = createModel();
  const ev = (type, data = {}) => ({ type, data, timestamp: new Date().toISOString() });
  model.ingest(id, ev('session.start'));
  model.ingest(id, ev('user.message', { content: 'Look at this' }));
  model.ingest(id, ev('tool.execution_start', { toolCallId: 'call', toolName: 'bash', arguments: { command: 'pwd' } }));
  model.setMeta(id, { alive: true });
  model.drain();
  return model.snapshot().sessions[0];
}
const snapshot = (sessions, now = Date.now()) => ({ type: 'snapshot', rev: 1, ready: true, now, sessions });

function fakeChild() {
  const child = new EventEmitter();
  for (const key of ['stdin', 'stdout', 'stderr']) child[key] = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  };
  child.send = (msg) => child.stdout.write(encodeMessage(msg));
  return child;
}

test('remote configuration rejects invalid hosts and quotes remote paths literally', async (t) => {
  const home = await temporary(t);
  assert.deepEqual(await loadRemotes(home), []);
  const path = join(home, 'copilot-viz.json');
  const config = (remotes) => writeFile(path, JSON.stringify({ version: 1, remotes }));
  for (const remotes of [[{}], [{ host: '-option' }], [{ host: 'a/b' }], [{ host: 'dev' }, { host: 'dev' }], [{ host: 'dev', node: '' }]]) {
    await config(remotes);
    await assert.rejects(loadRemotes(home), /Invalid or duplicate remote/);
  }
  await config([{ host: 'dev' }]);
  assert.equal((await loadRemotes(home))[0].script, 'dotfiles/files/scripts/copilot-viz/worker.mjs');
  const script = join(home, "worker ' spaces.mjs");
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const args = sshArgs({ host: 'dev', node: process.execPath, script, copilotHome: "a ' home" }, 1234);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('-x'));
  const out = await new Promise((resolve, reject) => execFile('sh', ['-c', args.at(-1)], (err, stdout) => err ? reject(err) : resolve(stdout)));
  assert.deepEqual(JSON.parse(out), ['--since', '1234', '--home', "a ' home"]);
});

test('sources isolate identical session IDs, retain disconnected data and route details by epoch', async (t) => {
  const callbacks = new Map();
  const requests = [];
  const store = createStore();
  const sources = createSources({
    remotes: [{ host: 'dev' }, { host: 'test' }], sinceMs: 1234, onMessage: (m) => store.apply(m), onError() {},
    remoteFactory: (config, options) => {
      assert.equal(options.sinceMs, 1234);
      callbacks.set(config.host, options);
      return { stop: async () => {}, call: async (...args) => { requests.push([config.host, ...args]); return { preview: config.host }; } };
    },
  });
  t.after(() => sources.stop());
  const original = session();
  const dev = callbacks.get('dev');
  const other = callbacks.get('test');
  dev.onMessage(snapshot([original], Date.now() + 3600_000));
  other.onMessage(snapshot([original]));
  assert.deepEqual([...store.sessions.keys()], ['dev/same', 'test/same']);
  const first = store.sessions.get('dev/same');
  assert.ok(Math.abs(sessionNow(first, Date.now()) - Date.now() - 3600_000) < 100);
  assert.deepEqual(await sources.callDetail(first.id, 'call', first.epoch), { preview: 'dev' });
  assert.deepEqual(requests[0], ['dev', 'same', 'call', original.epoch]);
  dev.onState('offline', 'Connection reset', Date.now() + 1000);
  const stale = store.sessions.get(first.id);
  assert.equal(stale.stale, true);
  assert.equal(isLive(stale, Date.now()), false);
  assert.equal(stale.calls[0].status, 'unknown');
  assert.equal(stale.agents[0].running, 0);
  assert.equal(sessionNow(stale, Date.now() + 99999), stale.sourceNow);
  await assert.rejects(sources.callDetail(first.id, 'call', first.epoch), { status: 503 });
  assert.equal(store.sessions.get('test/same').stale, false);

  dev.onState('loading', null, null);
  assert.throws(() => dev.onMessage(snapshot([original], NaN)), /Invalid sessions/);
  assert.equal(store.sessions.get(first.id).stale, true);
  dev.onMessage(snapshot([original, { id: 'invalid' }]));
  const next = store.sessions.get(first.id);
  assert.notEqual(next.epoch, first.epoch);
  await assert.rejects(sources.callDetail(first.id, 'call', first.epoch), { status: 409 });
  dev.onMessage(snapshot([]));
  assert.deepEqual([...store.sessions.keys()], ['test/same']);
});

test('session ordering compares clocks of different hosts on the local timeline', () => {
  const recent = { ...session('recent'), clockOffset: -3600_000 };
  const older = { ...session('older'), clockOffset: 3600_000 };
  assert.equal(sortSessions([older, recent])[0].id, 'recent');
});

test('the JSON wire preserves split UTF-8 and never publishes a truncated message', () => {
  const input = new PassThrough();
  const messages = [];
  const errors = [];
  const stop = readMessages(input, (m) => messages.push(m), (e) => errors.push(e));
  const bytes = Buffer.from(encodeMessage({ text: '日本語' }));
  for (const byte of bytes) input.write(Buffer.from([byte]));
  input.write('{"unfinished":');
  assert.deepEqual(messages, [{ text: '日本語' }]);
  assert.equal(errors.length, 0);
  stop();
});

test('an oversized worker snapshot fails permanently instead of retrying it forever', () => {
  assert.throws(() => encodeMessage({ data: 'x'.repeat(MAX_MESSAGE) }), { permanent: true });
});

test('SSH failures reject pending details, retry, and stop prevents further attempts', async (t) => {
  const children = [];
  const states = [];
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1234, retryMs: 10, onMessage() {}, onState: (...args) => states.push(args),
    spawnProcess: () => { const c = fakeChild(); children.push(c); return c; },
  });
  t.after(() => remote.stop());
  remote.start();
  const child = children[0];
  child.send({ type: 'hello', protocol: PROTOCOL });
  child.send(snapshot([]));
  const rejected = assert.rejects(remote.call('sid', 'call', 'epoch'), { status: 503 });
  child.stderr.write('Connection refused');
  child.emit('close', 255, null);
  await rejected;
  assert.match(states.at(-1)[1], /Connection refused/);
  await waitFor(() => children.length === 2);
  await remote.stop();
  await sleep(40);
  assert.equal(children.length, 2);
});

test('a protocol mismatch is visible and does not retry an incompatible installation', async (t) => {
  let attempts = 0;
  const states = [];
  const child = fakeChild();
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1, retryMs: 5, onMessage() {}, onState: (...s) => states.push(s),
    spawnProcess: () => { attempts++; return child; },
  });
  t.after(() => remote.stop());
  remote.start();
  child.send({ type: 'hello', protocol: PROTOCOL + 1 });
  await sleep(30);
  assert.equal(attempts, 1);
  assert.equal(states.at(-1)[0], 'offline');
  assert.equal(states.at(-1)[2], null);
  assert.match(states.at(-1)[1], /update dotfiles/);
});

test('the real worker reads logs and details over SSH stdio and exits on EOF', { timeout: 10_000 }, async (t) => {
  const home = await temporary(t);
  const dir = join(home, 'session-state', 'same');
  await mkdir(dir, { recursive: true });
  const event = (type, data = {}) => JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  await writeFile(join(dir, 'events.jsonl'), [
    event('session.start'),
    event('tool.execution_start', { toolCallId: 'C', toolName: 'bash', arguments: { command: 'pwd' } }),
    event('tool.execution_complete', { toolCallId: 'C', success: true, result: { content: 'worker result' } }),
  ].join('\n') + '\n');
  const child = spawn(process.execPath, [join(HERE, 'worker.mjs'), '--home', home, '--since', '86400000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  let errors = '';
  child.stderr.on('data', (b) => { errors += b; });
  const messages = [];
  readMessages(child.stdout, (m) => messages.push(m), (e) => { throw e; });
  await waitFor(() => messages.some((m) => m.type === 'snapshot'));
  const state = messages.find((m) => m.type === 'snapshot');
  assert.equal(state.ready, true, errors);
  const s = state.sessions[0];
  child.stdin.write(encodeMessage({ type: 'call', request: 1, sid: 'same', id: 'C', epoch: s.epoch }));
  await waitFor(() => messages.some((m) => m.type === 'reply'));
  assert.equal(messages.find((m) => m.type === 'reply').data.preview, 'worker result');
  child.stdin.write(encodeMessage({ type: 'call', request: 2, sid: 'same', id: 'C', epoch: 'old-epoch' }));
  await waitFor(() => messages.some((m) => m.request === 2));
  assert.equal(messages.find((m) => m.request === 2).status, 409);
  child.stdin.end();
  assert.equal((await exited)[0], 0, errors);
});

test('a pause closes SSH without retries, and a resume connects again while the old child still exits', async (t) => {
  const children = [];
  const states = [];
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1, retryMs: 5, onMessage() {}, onState: (s) => states.push(s),
    spawnProcess: () => { const c = fakeChild(); children.push(c); return c; },
  });
  t.after(() => remote.stop());
  remote.start();
  const old = children[0];
  old.send({ type: 'hello', protocol: PROTOCOL });
  old.send(snapshot([]));
  old.kill = () => true;
  let oldClosed = false;
  const closeOld = () => { if (!oldClosed) { oldClosed = true; old.emit('close', 0, null); } };
  try {
    const rejected = assert.rejects(remote.call('sid', 'call', 'epoch'), { status: 503 });
    remote.pause();
    await rejected;
    assert.equal(states.at(-1), 'paused');
    await sleep(30);
    assert.equal(children.length, 1);

    remote.resume();
    assert.equal(children.length, 2);
    children[1].send({ type: 'hello', protocol: PROTOCOL });
    children[1].send(snapshot([]));
    await sleep(10);
  } finally {
    // The old child ignores signals, so remote.stop() in teardown waits for this close.
    closeOld();
  }
  await sleep(30);
  assert.deepEqual(states.slice(states.indexOf('paused') + 1), ['connecting', 'loading']);
  const reply = remote.call('sid', 'call', 'epoch');
  children[1].send({ type: 'reply', request: 2, data: { preview: 'new' } });
  assert.deepEqual(await reply, { preview: 'new' });
});

test('a pause cancels a pending retry, and leaves a permanent failure as it is', async (t) => {
  const children = [];
  const states = [];
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1, retryMs: 50, onMessage() {}, onState: (...s) => states.push(s),
    spawnProcess: () => { const c = fakeChild(); children.push(c); return c; },
  });
  t.after(() => remote.stop());
  remote.start();
  children[0].emit('close', 255, null);
  assert.equal(states.at(-1)[0], 'offline');
  remote.pause();
  assert.equal(states.at(-1)[0], 'paused');
  await sleep(100);
  assert.equal(children.length, 1);

  remote.resume();
  children[1].send({ type: 'hello', protocol: PROTOCOL + 1 });
  await sleep(10);
  const failed = states.at(-1);
  assert.equal(failed[0], 'offline');
  remote.pause();
  remote.resume();
  await sleep(30);
  assert.equal(states.at(-1), failed);
  assert.equal(children.length, 2);
});

test('stopping SSH escalates and waits for a TERM-resistant child', { timeout: 5000 }, async (t) => {
  let child;
  let initialized = false;
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1, onMessage() {}, onState: (s) => { if (s === 'loading') initialized = true; },
    spawnProcess: () => {
      child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); process.stdout.write('${JSON.stringify({ type: 'hello', protocol: PROTOCOL })}\\n'); setInterval(()=>{},1000);`], { stdio: ['pipe', 'pipe', 'pipe'] });
      return child;
    },
  });
  t.after(() => child?.kill('SIGKILL'));
  remote.start();
  await waitFor(() => initialized);
  await remote.stop();
  assert.equal(child.signalCode, 'SIGKILL');
});

test('an invalid batch changes no host data and retries only publish host metadata', async (t) => {
  let dev;
  const messages = [];
  const errors = [];
  const sources = createSources({
    remotes: [{ host: 'dev' }], onError: (e) => errors.push(e), onMessage: (m) => messages.push(m),
    remoteFactory: (_, options) => { dev = options; return { stop() {} }; },
  });
  t.after(() => sources.stop());
  dev.onMessage(snapshot([session()]));
  const before = sources.snapshot();
  assert.throws(() => dev.onMessage({ ...snapshot([session('new')], 1), removed: [42] }), /Invalid sessions/);
  assert.deepEqual(sources.snapshot().hosts, before.hosts);
  dev.onState('offline', 'lost connection', null);
  assert.deepEqual(messages.at(-1).sessions.map((s) => s.id), ['dev/same']);
  assert.equal(messages.at(-1).sessions[0].sourceNow, before.sessions[0].sourceNow);
  dev.onState('connecting', null, null);
  assert.deepEqual(messages.at(-1).sessions, []);
  assert.equal(errors.length, 1);
});

test('invalid ready snapshots retain the reconnect backoff', async (t) => {
  const children = [];
  const delays = [];
  const remote = createRemote({ host: 'dev', node: 'node', script: 'worker.mjs' }, {
    sinceMs: 1, retryMs: 50, onMessage() { throw new Error('Rejected snapshot'); },
    onState(state, error, retryAt) { if (state === 'offline') delays.push(retryAt - Date.now()); },
    spawnProcess() { const c = fakeChild(); children.push(c); return c; },
  });
  t.after(() => remote.stop());
  remote.start();
  for (let i = 0; i < 2; i++) {
    await waitFor(() => children[i]);
    children[i].send({ type: 'hello', protocol: PROTOCOL });
    children[i].send(snapshot([]));
  }
  assert.ok(delays[1] > delays[0] + 30);
});

// The pipe still carries real frames. Its write result and drain event are under test control.
async function blockedWorker(t, home) {
  const prelude = `
    const write = process.stdout.write.bind(process.stdout);
    let blocked = true;
    process.stdout.write = (frame) => {
      if (JSON.parse(frame).type === 'snapshot') blocked = true;
      return write(frame) && !blocked;
    };
    Object.defineProperty(process.stdout, 'writableLength', { get: () => blocked ? 2 ** 21 : 0 });
    process.on('message', () => { blocked = false; process.stdout.emit('drain'); });
  `;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(prelude)}`,
    join(HERE, 'worker.mjs'), '--home', home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const messages = [];
  const errors = [];
  child.stderr.on('data', (b) => errors.push(b.toString()));
  readMessages(child.stdout, (m) => messages.push(m), (e) => { throw e; });
  await waitFor(() => messages[0]?.type === 'hello');
  return { child, messages, errors };
}

test('a blocked worker sends a ready baseline even for an empty home', async (t) => {
  const { child, messages } = await blockedWorker(t, await temporary(t));
  await sleep(500);
  assert.deepEqual(messages.map((m) => m.type), ['hello']);
  child.send('drain');
  await waitFor(() => messages.length > 1);
  assert.equal(messages[1].type, 'snapshot');
  assert.equal(messages[1].ready, true);
  assert.deepEqual(messages[1].sessions, []);
});

test('a slow worker survives collector errors and busy detail replies, then flushes removals as a delta', async (t) => {
  const home = await temporary(t);
  const dir = join(home, 'session-state', 'sid');
  await mkdir(join(dir, 'workspace.yaml'), { recursive: true });
  await writeFile(join(dir, 'events.jsonl'), '');
  const { child, messages, errors } = await blockedWorker(t, home);
  await waitFor(() => errors.join('').includes('EISDIR'));
  const call = (request) => child.stdin.write(encodeMessage({ type: 'call', request, sid: 'sid', id: 'C', epoch: 'E' }));
  call(1);
  await waitFor(() => messages.some((m) => m.request === 1));
  assert.deepEqual(messages.at(-1), { type: 'reply', request: 1, error: 'Too many pending detail replies.', status: 503 });
  child.send('drain');
  await waitFor(() => messages.some((m) => m.type === 'snapshot'));
  assert.equal(messages.at(-1).sessions[0].id, 'sid');
  await rm(dir, { recursive: true });
  // Allow a discovery and a collector interval to run while the baseline write is blocked.
  await sleep(5700);
  child.send('drain');
  await waitFor(() => messages.at(-1).type !== 'snapshot');
  assert.equal(messages.at(-1).type, 'delta');
  assert.deepEqual(messages.at(-1).removed, ['sid']);
});
