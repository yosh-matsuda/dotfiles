import { hostname } from 'node:os';
import { createCollector } from './collector.mjs';
import { validSessionId } from './monitor.mjs';
import { validSession } from './public/schema.mjs';
import { createRemote } from './remote.mjs';
import { unavailable } from './wire.mjs';

const ACTIVE = new Set(['running', 'starting', 'input', 'waiting']);

export function createSources({ remotes = [], sinceMs, onMessage, onError, remoteFactory = createRemote }) {
  const hosts = new Map();
  const sessions = new Map();
  let rev = 0;
  let stopped = false;
  const makeHost = (id, name, remote) => {
    const h = { id, name, remote, state: 'connecting', error: null, retryAt: null, lastSeen: null, settled: false, generation: 0, raw: new Map(), invalid: new Set(), offset: 0, sourceNow: null };
    hosts.set(id, h);
    return h;
  };
  const local = makeHost('local', hostname(), false);
  const ready = () => [...hosts.values()].every((h) => h.settled);
  const hostList = () => [...hosts.values()].map(({ id, name, remote, state, error, retryAt, lastSeen }) => ({ id, name, remote, state, error, retryAt, lastSeen }));
  const sessionId = (h, id) => h.remote ? `${h.name}/${id}` : id;

  function project(h, raw) {
    const stale = h.remote && h.state !== 'live';
    const s = {
      ...raw, id: sessionId(h, raw.id), sourceId: raw.id, host: h.id, hostName: remotes.length ? h.name : null,
      epoch: h.remote ? `${h.generation}:${raw.epoch}` : raw.epoch, rev,
      clockOffset: h.offset, sourceNow: h.sourceNow, stale,
    };
    if (stale) {
      s.state = 'offline';
      s.agents = raw.agents.map((a) => ACTIVE.has(a.display) || a.display === 'idle'
        ? { ...a, display: 'unknown', current: null, running: 0, compacting: false } : a);
      s.calls = raw.calls.map((c) => c.status === 'running' ? { ...c, status: 'unknown', perm: false } : c);
      s.shells = raw.shells.map((sh) => sh.status === 'running' ? { ...sh, status: 'unknown' } : sh);
    }
    return s;
  }
  function publish(h, ids = [], removed = []) {
    if (stopped) return;
    rev++;
    const changed = ids.map((id) => project(h, h.raw.get(id)));
    for (const id of removed) sessions.delete(id);
    for (const s of changed) sessions.set(s.id, s);
    onMessage({ type: 'delta', now: Date.now(), rev, ready: ready(), hosts: hostList(), sessions: changed, removed });
  }
  function receive(h, msg) {
    if (stopped) return;
    const now = Date.now();
    const batch = msg.type === 'snapshot' || msg.type === 'delta';
    if (batch && (!Number.isFinite(msg.now) || !Array.isArray(msg.sessions)
      || (msg.removed !== undefined && (!Array.isArray(msg.removed) || !msg.removed.every(validSessionId))))) {
      throw new Error('Invalid sessions from the SSH worker.');
    }
    h.lastSeen = now;
    h.sourceNow = msg.now;
    if (batch) {
      const accepted = [];
      const present = new Set();
      for (const s of msg.sessions) {
        const id = typeof s?.id === 'string' ? s.id : null;
        present.add(id);
        if (validSessionId(id) && validSession(s) && s.epoch.length <= 200) {
          accepted.push(s);
          h.invalid.delete(id);
        } else if (!h.invalid.has(id)) {
          h.invalid.add(id);
          onError(new Error(`${h.name}: invalid session ${id ?? '(missing ID)'}.`));
        }
      }
      const removed = [];
      const remove = (id) => {
        if (h.raw.delete(id)) removed.push(sessionId(h, id));
      };
      if (msg.type === 'snapshot') {
        // An invalid replacement leaves the last accepted copy alone.
        for (const id of h.raw.keys()) if (!present.has(id)) remove(id);
        if (h.state !== 'live') h.generation++;
      }
      for (const id of msg.removed ?? []) if (!present.has(id)) remove(id);
      for (const s of accepted) h.raw.set(s.id, s);
      h.offset = h.remote ? msg.now - now : 0;
      if (msg.ready) {
        h.state = 'live';
        h.settled = true;
        h.error = null;
        h.retryAt = null;
      }
      publish(h, accepted.map((s) => s.id), removed);
    } else if (msg.type === 'status') {
      if (msg.ready) {
        h.state = 'live';
        h.settled = true;
      }
      publish(h);
    }
  }
  local.collector = createCollector({ sinceMs, onMessage: (msg) => receive(local, msg), onError });
  for (const config of remotes) {
    const h = makeHost(`ssh:${config.host}`, config.host, true);
    h.connection = remoteFactory(config, {
      sinceMs,
      onMessage: (msg) => receive(h, msg),
      onState: (state, error, retryAt) => {
        const leavingLive = h.state === 'live' && state !== 'live';
        h.state = state;
        h.error = error;
        h.retryAt = retryAt;
        if (state === 'offline' || state === 'paused') h.settled = true;
        if (state === 'offline') onError(new Error(`${h.name}: ${error}`));
        try {
          publish(h, leavingLive ? [...h.raw.keys()] : []);
        } catch (e) {
          onError(e);
        }
      },
    });
  }
  return {
    start() {
      local.state = 'loading';
      local.collector.start().catch((e) => {
        local.state = 'offline';
        local.error = e.message;
        local.settled = true;
        onError(e);
        publish(local);
      });
      for (const h of hosts.values()) h.connection?.start();
    },
    // The sessions of a paused host stay, marked stale like those of a disconnected one.
    pause() {
      for (const h of hosts.values()) h.connection?.pause();
    },
    resume() {
      for (const h of hosts.values()) h.connection?.resume();
    },
    async stop() {
      stopped = true;
      local.collector.stop();
      await Promise.all([...hosts.values()].map((h) => h.connection?.stop()));
    },
    snapshot: () => ({ type: 'snapshot', now: Date.now(), rev, ready: ready(), hosts: hostList(), sessions: [...sessions.values()] }),
    async callDetail(sid, id, epoch) {
      const s = sessions.get(sid);
      if (!s) return null;
      const h = hosts.get(s.host);
      if (epoch !== undefined && epoch !== s.epoch) throw Object.assign(new Error('This session was reloaded; select the call again.'), { status: 409 });
      if (h.remote) {
        if (h.state !== 'live') throw unavailable(`${h.name} is not connected. Showing its last received state.`);
        const raw = h.raw.get(s.sourceId);
        return h.connection.call(s.sourceId, id, raw.epoch);
      }
      return local.collector.callDetail(s.sourceId, id, epoch);
    },
  };
}
