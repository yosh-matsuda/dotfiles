// Client state for the /api/stream messages. The page and the tests share this module.

import { identified, listOf, record, validSession } from './schema.mjs';

export const QUIET_MS = 5 * 60_000;
const LIVE_MS = 30 * 60_000;
// write_agent woke 90% of the idle agents within an hour. A subagent idle longer folds into a
// chip on the map and its idle stripe ends on the timeline; it unfolds when it runs again. The
// map also drops the shells that ended this long ago.
export const DORMANT_MS = 60 * 60_000;

export function createStore() {
  const sessions = new Map();
  const hosts = new Map();
  let rev = 0;
  let ready = false;
  let offset = 0;
  return {
    sessions, hosts,
    get rev() { return rev; },
    get ready() { return ready; },
    // Server time, so that durations agree with the timestamps of the logs.
    now: () => Date.now() + offset,
    // A snapshot replaces everything; a delta carries the full state of each changed session.
    apply(msg) {
      // The model's drain also supplies deltas without a type.
      if (!record(msg) || !(msg.type === 'snapshot' || msg.type === 'delta' || (msg.type === undefined && Array.isArray(msg.removed)))
        || !Number.isSafeInteger(msg.rev) || msg.rev < 0 || (msg.type !== 'snapshot' && msg.rev <= rev)
        || (msg.ready !== undefined && typeof msg.ready !== 'boolean') || (msg.now !== undefined && !Number.isFinite(msg.now))
        || (msg.hosts !== undefined && !listOf(msg.hosts, identified))
        || (msg.removed !== undefined && !listOf(msg.removed, (id) => typeof id === 'string'))
        || !listOf(msg.sessions, validSession)) return false;
      if (typeof msg.ready === 'boolean') ready = msg.ready;
      if (typeof msg.now === 'number') offset = msg.now - Date.now();
      if (Array.isArray(msg.hosts)) {
        hosts.clear();
        for (const host of msg.hosts) hosts.set(host.id, host);
      }
      if (msg.type === 'snapshot') sessions.clear();
      for (const s of msg.sessions) sessions.set(s.id, s);
      for (const id of msg.removed ?? []) sessions.delete(id);
      rev = msg.rev;
      return true;
    },
  };
}

// An auto (fusion) session writes the main agent's work only when a turn commits, so silence
// there means nothing.
export function isQuiet(agent, session, now) {
  if (agent.display !== 'running' || agent.running > 0 || session.meta.batched) return false;
  return agent.lastActivityAt != null && now - agent.lastActivityAt > QUIET_MS;
}

// `alive` is null where the server cannot see the processes; recent events stand in for it.
export function isLive(s, now) {
  if (s.stale) return false;
  if (typeof s.alive === 'boolean') return s.alive;
  if (s.state === 'running' || s.state === 'attention') return true;
  return s.meta.lastEventAt != null && now - s.meta.lastEventAt < LIVE_MS;
}

// The time a session is shown at: an ended session shows its own last minutes.
export function viewEnd(s, now) {
  if (s.stale) {
    if (s.alive !== false && s.state !== 'ended' && !(s.state === 'offline' && s.meta.endedAt != null)) return now;
  } else if (isLive(s, now)) return now;
  return Math.min(now, s.meta.lastEventAt ?? now);
}

// When an idle agent went idle; a read of its status later does not count.
export function idleSince(agent) {
  const p = agent.phases?.at(-1);
  return p?.state === 'idle' && p.end == null ? p.start : agent.lastActivityAt;
}

export function isDormant(agent, at) {
  if (agent.kind === 'main' || agent.display !== 'idle') return false;
  const since = idleSince(agent);
  return since != null && at - since > DORMANT_MS;
}

export function wallNow(s, now) {
  return now + (s?.clockOffset ?? 0);
}

export function sessionNow(s, now) {
  return s?.stale && s.sourceNow != null ? s.sourceNow : wallNow(s, now);
}

export function runningSince(a, s) {
  if (a.kind !== 'main') return a.startedAt;
  return a.turnStartedAt ?? s.feed.findLast((f) => f.kind === 'user')?.ts ?? a.startedAt
    ?? s.meta.startedAt ?? s.calls.find((c) => c.agent === 'main')?.startedAt;
}

export function sessionTitle(s) {
  return s.name || s.meta.title || s.id.slice(0, 8);
}

export function sortSessions(list) {
  const rank = { attention: 0, running: 1, idle: 2, ended: 3 };
  return [...list].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9)
    || ((b.meta.lastEventAt ?? 0) - (b.clockOffset ?? 0)) - ((a.meta.lastEventAt ?? 0) - (a.clockOffset ?? 0)));
}

// Agents in tree order: each parent before its children, oldest first.
export function agentTree(s) {
  const byParent = new Map();
  const keys = new Set(s.agents.map((a) => a.key));
  for (const a of s.agents) {
    if (a.kind === 'main') continue;
    const p = keys.has(a.parent) ? a.parent : 'main';
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(a);
  }
  const out = [];
  const main = s.agents.find((a) => a.kind === 'main');
  if (main) out.push({ agent: main, depth: 0 });
  for (const list of byParent.values()) list.sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));
  const stack = [];
  const pushChildren = (key, depth) => {
    const list = byParent.get(key) ?? [];
    for (let i = list.length - 1; i >= 0; i--) stack.push({ agent: list[i], depth });
  };
  const seen = new Set(['main']);
  pushChildren('main', 1);
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.agent.key)) continue;
    seen.add(row.agent.key);
    out.push(row);
    pushChildren(row.agent.key, Math.min(row.depth + 1, 8));
  }
  return out;
}

export function activityIn(s, now, minutes) {
  const from = Math.floor(now / 60_000) - minutes + 1;
  let n = 0;
  for (const [m, count] of s.activity) if (m >= from) n += count;
  return n;
}

// Counts per minute for the last `minutes` minutes, oldest first.
export function sparkline(s, now, minutes) {
  const end = Math.floor(now / 60_000);
  const out = new Array(minutes).fill(0);
  for (const [m, count] of s.activity) {
    const i = minutes - 1 - (end - m);
    if (i >= 0 && i < minutes) out[i] += count;
  }
  return out;
}
