// Read-only SSH worker. stdout is the protocol; it never opens a listening socket.
import { parseArgs } from 'node:util';
import { createCollector } from './collector.mjs';
import { copilotHome } from './monitor.mjs';
import { encodeMessage, HEARTBEAT_MS, PROTOCOL, readMessages } from './wire.mjs';

const { values } = parseArgs({ options: { since: { type: 'string' }, home: { type: 'string' } } });
const sinceMs = Number(values.since ?? 864e5);
if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new Error('Invalid --since in the worker request.');

let stopped = false;
let initialized = false;
let blocked = false;
let stale = false;
let heardAt = Date.now();
let unlisten = () => {};
const timers = [];
const collector = createCollector({
  home: values.home ?? copilotHome(), sinceMs,
  onMessage: (msg) => {
    if (initialized) update(msg);
  },
  onError: (e) => fail(e),
});

function stop() {
  if (stopped) return;
  stopped = true;
  collector.stop();
  for (const t of timers) clearInterval(t);
  unlisten();
  process.stdin.destroy();
}
function send(msg) {
  if (stopped) return;
  blocked = !process.stdout.write(encodeMessage(msg));
}
function fail(e) {
  if (stopped) return;
  process.stderr.write(`copilot-viz worker: ${e.message}\n`);
  process.stdout.end(encodeMessage({ type: 'error', error: e.message, permanent: Boolean(e.permanent) }));
  process.exitCode = 1;
  stop();
  setTimeout(() => process.exit(1), 1000).unref();
}
function update(msg) {
  if (stopped) return;
  if (blocked) {
    stale = true;
    return;
  }
  try {
    send(msg);
  } catch (e) {
    fail(e);
  }
}
process.stdout.on('error', () => stop());
process.stdout.on('drain', () => {
  blocked = false;
  if (stale && !stopped) {
    stale = false;
    update(collector.snapshot());
  }
});
unlisten = readMessages(process.stdin, (msg) => {
  heardAt = Date.now();
  if (msg.type === 'ping') return;
  if (msg.type !== 'call' || !Number.isSafeInteger(msg.request) || msg.request < 1
    || typeof msg.sid !== 'string' || msg.sid.length > 200 || typeof msg.id !== 'string' || msg.id.length > 200
    || typeof msg.epoch !== 'string' || msg.epoch.length > 200) throw new Error('Invalid worker request.');
  if (process.stdout.writableLength > 1 << 20) throw new Error('Too many pending detail replies.');
  let data;
  try {
    data = collector.callDetail(msg.sid, msg.id, msg.epoch);
  } catch (e) {
    send({ type: 'reply', request: msg.request, error: e.message, status: e.status ?? 500 });
    return;
  }
  send({ type: 'reply', request: msg.request, data });
}, fail);
process.stdin.on('end', stop);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);
send({ type: 'hello', protocol: PROTOCOL });
timers.push(setInterval(() => {
  if (Date.now() - heardAt > 45_000) return fail(new Error('The SSH client stopped responding.'));
  if (!blocked) update({ type: 'heartbeat', now: Date.now() });
}, HEARTBEAT_MS));
collector.start().then(() => {
  if (stopped) return;
  initialized = true;
  update(collector.snapshot());
}, fail);
