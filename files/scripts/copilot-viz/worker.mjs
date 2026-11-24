// Read-only SSH worker. stdout is the protocol; it never opens a listening socket.
import { parseArgs } from 'node:util';
import { createCollector } from './collector.mjs';
import { copilotHome } from './monitor.mjs';
import { encodeMessage, HEARTBEAT_MS, PROTOCOL, readMessages } from './wire.mjs';

const { values } = parseArgs({ options: { since: { type: 'string' }, home: { type: 'string' } } });
const sinceMs = Number(values.since ?? 864e5);
if (!Number.isFinite(sinceMs) || sinceMs < 0) throw new Error('Invalid --since in the worker request.');

let stopped = false;
let ready = false;
let baselineOwed = true;
let blocked = false;
let heartbeatQueued = false;
let errors = 0;
let heardAt = Date.now();
let unlisten = () => {};
const timers = [];
const collector = createCollector({
  home: values.home ?? copilotHome(), sinceMs,
  canFlush: () => !blocked,
  onMessage: (msg) => { if (!baselineOwed) update(msg); },
  onError: (e) => {
    if (++errors <= 20 || errors % 1000 === 0) process.stderr.write(`copilot-viz worker: collector error ${errors}: ${e.message}\n`);
  },
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
  try {
    send(msg);
  } catch (e) {
    fail(e);
  }
}
function resume() {
  if (!ready || blocked || stopped) return;
  if (baselineOwed) {
    // The snapshot includes changes accumulated while even the hello was blocked.
    collector.flush();
    update(collector.snapshot());
    baselineOwed = false;
  } else {
    collector.flush();
  }
}
process.stdout.on('error', () => stop());
process.stdout.on('drain', () => {
  blocked = false;
  heartbeatQueued = false;
  resume();
});
unlisten = readMessages(process.stdin, (msg) => {
  heardAt = Date.now();
  if (msg.type === 'ping') return;
  if (msg.type !== 'call' || !Number.isSafeInteger(msg.request) || msg.request < 1
    || typeof msg.sid !== 'string' || msg.sid.length > 200 || typeof msg.id !== 'string' || msg.id.length > 200
    || typeof msg.epoch !== 'string' || msg.epoch.length > 200) throw new Error('Invalid worker request.');
  if (process.stdout.writableLength > 1 << 20) {
    return send({ type: 'reply', request: msg.request, error: 'Too many pending detail replies.', status: 503 });
  }
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
  if (!heartbeatQueued) {
    update({ type: 'heartbeat', now: Date.now() });
    heartbeatQueued = blocked;
  }
}, HEARTBEAT_MS));
collector.start().then(() => {
  if (stopped) return;
  ready = true;
  resume();
}, fail);
