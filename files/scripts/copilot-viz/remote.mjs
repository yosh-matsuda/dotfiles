import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copilotHome } from './monitor.mjs';
import { encodeMessage, HEARTBEAT_MS, PROTOCOL, readMessages, unavailable } from './wire.mjs';

const HOST = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,127}$/;
const DEFAULT_SCRIPT = 'dotfiles/files/scripts/copilot-viz/worker.mjs';
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !/[\x00-\x1f\x7f]/.test(s);

export async function loadRemotes(home = copilotHome()) {
  const path = join(home, 'copilot-viz.json');
  let body;
  try {
    body = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${path}: ${e.message}`);
  }
  let config;
  try {
    config = JSON.parse(body);
  } catch {
    throw new Error(`Invalid JSON in ${path}.`);
  }
  if (!config || config.version !== 1 || !Array.isArray(config.remotes) || config.remotes.length > 32
    || Object.keys(config).some((k) => !['version', 'remotes'].includes(k))) throw new Error(`Expected version 1 and up to 32 remotes in ${path}.`);
  const seen = new Set();
  return config.remotes.map((r) => {
    if (!r || typeof r !== 'object' || typeof r.host !== 'string' || !HOST.test(r.host) || seen.has(r.host)
      || Object.keys(r).some((k) => !['host', 'node', 'script', 'copilotHome'].includes(k))
      || ['node', 'script', 'copilotHome'].some((k) => r[k] !== undefined && !text(r[k]))) {
      throw new Error(`Invalid or duplicate remote in ${path}; use an SSH Host name and optional node, script and copilotHome paths.`);
    }
    seen.add(r.host);
    return { host: r.host, node: r.node ?? 'node', script: r.script ?? DEFAULT_SCRIPT, ...(r.copilotHome ? { copilotHome: r.copilotHome } : {}) };
  });
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
export function sshArgs(config, sinceMs) {
  const args = [config.node, '--', config.script, '--since', String(sinceMs)];
  if (config.copilotHome) args.push('--home', config.copilotHome);
  // Paths are absolute or relative to HOME. Neither paths nor aliases are evaluated as shell text.
  const command = `cd "$HOME" && exec ${args.map(quote).join(' ')}`;
  return [
    '-T', '-x', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'RemoteCommand=none', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '--', config.host, `sh -c ${quote(command)}`,
  ];
}

export function createRemote(config, {
  sinceMs, onMessage, onState, spawnProcess = spawn, retryMs = 1000, timeoutMs = 40_000,
} = {}) {
  let current = null;
  let stopped = false;
  let retry = null;
  let attempts = 0;
  let sequence = 0;
  const children = new Set();

  function connect() {
    if (stopped) return;
    onState('connecting', null, null);
    const child = spawnProcess('ssh', sshArgs(config, sinceMs), { stdio: ['pipe', 'pipe', 'pipe'] });
    const a = { child, hello: false, baseline: false, pending: new Map(), stderr: '', heard: Date.now(), dead: false };
    current = a;
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const tracked = { child, exited };
    children.add(tracked);
    let escalation;
    const terminate = () => {
      child.stdin.destroy();
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    a.terminate = terminate;
    const fail = (e) => {
      if (a.dead) return;
      a.dead = true;
      clearInterval(a.timer);
      a.unlisten?.();
      for (const p of a.pending.values()) {
        clearTimeout(p.timer);
        p.reject(unavailable(e.message));
      }
      a.pending.clear();
      terminate();
      if (stopped) return;
      const delay = Math.min(30_000, retryMs * 2 ** Math.min(attempts++, 5));
      onState('offline', e.message, e.permanent ? null : Date.now() + delay);
      if (!e.permanent) retry = setTimeout(connect, delay);
    };
    a.fail = fail;
    child.stderr.on('data', (chunk) => { a.stderr = (a.stderr + chunk.toString()).slice(-4096); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.once('close', (code, signal) => {
      if (!a.dead) fail(new Error(a.stderr.trim() || `SSH closed (${signal ?? code}).`));
      clearTimeout(escalation);
      children.delete(tracked);
      resolveExit();
    });
    a.unlisten = readMessages(child.stdout, (msg) => {
      a.heard = Date.now();
      if (!a.hello) {
        if (msg.type !== 'hello' || msg.protocol !== PROTOCOL) {
          throw Object.assign(new Error('Incompatible remote worker; update dotfiles on this host.'), { permanent: true });
        }
        a.hello = true;
        a.loadingAt = Date.now();
        onState('loading', null, null);
        return;
      }
      if (msg.type === 'error') throw Object.assign(new Error(String(msg.error)), { permanent: Boolean(msg.permanent) });
      if (msg.type === 'reply') {
        const p = a.pending.get(msg.request);
        if (!p) return;
        clearTimeout(p.timer);
        a.pending.delete(msg.request);
        if (msg.error) p.reject(Object.assign(new Error(String(msg.error)), { status: msg.status === 409 ? 409 : 503 }));
        else p.resolve(msg.data ?? null);
        return;
      }
      if (!Number.isFinite(msg.now)) throw new Error('Worker message has no clock.');
      if (msg.type === 'heartbeat') {
        onMessage(msg);
        return;
      }
      if (!['snapshot', 'delta', 'status'].includes(msg.type)) throw new Error('Unexpected worker message.');
      if (!a.baseline && msg.type !== 'snapshot') throw new Error('Worker sent changes without a snapshot.');
      if (msg.type === 'snapshot') {
        if (msg.ready !== true) throw new Error('Worker snapshot is incomplete.');
        a.baseline = true;
        attempts = 0;
      }
      onMessage(msg);
    }, fail);
    a.timer = setInterval(() => {
      const now = Date.now();
      if ((!a.hello && now - a.heard > Math.min(timeoutMs, 15_000)) || now - a.heard > timeoutMs
        || (a.hello && !a.baseline && now - a.loadingAt > 120_000)) {
        return fail(new Error('SSH worker timed out.'));
      }
      if (child.stdin.writableLength > 65536) return fail(new Error('SSH worker is not reading requests.'));
      child.stdin.write(encodeMessage({ type: 'ping' }));
    }, Math.min(HEARTBEAT_MS, timeoutMs / 2));
  }

  return {
    start: connect,
    call(sid, id, epoch) {
      const a = current;
      if (!a || a.dead || !a.baseline) return Promise.reject(unavailable('This host is not connected.'));
      if (a.pending.size >= 32) return Promise.reject(unavailable('Too many pending remote detail requests.'));
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          a.pending.delete(request);
          reject(unavailable('Remote call details timed out.'));
        }, 10_000);
        a.pending.set(request, { resolve, reject, timer });
        a.child.stdin.write(encodeMessage({ type: 'call', request, sid, id, epoch }));
      });
    },
    async stop() {
      stopped = true;
      clearTimeout(retry);
      current?.fail(new Error('The local server stopped.'));
      await Promise.all([...children].map((c) => c.exited));
    },
  };
}
