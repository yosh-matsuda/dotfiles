import assert from 'node:assert/strict';
import test from 'node:test';
import * as store from './public/store.mjs';
import { canvasRatio } from './public/timeline.mjs';
import { createCallDetails, ranFor } from './public/detail.mjs';

const session = { id: 'one', epoch: 'a', meta: { lastEventAt: 10 }, agents: [], calls: [], shells: [], feed: [], activity: [] };

test('disconnect freezes active sessions at source time and ended sessions at their last event', () => {
  const s = { ...session, stale: true, sourceNow: 50, clockOffset: 20 };
  assert.equal(store.viewEnd(s, store.sessionNow(s, 100)), 50);
  for (const end of [{ alive: false }, { state: 'ended' }]) assert.equal(store.viewEnd({ ...s, ...end }, 50), 10);
  assert.equal(store.wallNow(s, 100), 120);
});

test('a rejected message cannot replace data, change the clock or advance readiness', (t) => {
  t.mock.method(Date, 'now', () => 100);
  const c = store.createStore();
  const snapshot = { type: 'snapshot', rev: 8, ready: true, now: 110, hosts: [{ id: 'local' }], sessions: [session] };
  assert.ok(c.apply(snapshot));
  const delta = { type: 'delta', rev: 9, ready: false, now: 200, hosts: [], sessions: [] };
  for (const invalid of [{ rev: 8 }, { type: 'other' }, { sessions: [session, null] }, { hosts: [null] }, { removed: 'one' }, { sessions: [{ ...session, activity: [null] }] }]) {
    assert.equal(c.apply({ ...delta, ...invalid }), false);
    assert.deepEqual([...c.sessions.values()], [session]);
    assert.deepEqual([...c.hosts.keys()], ['local']);
    assert.equal(c.now(), 110);
    assert.equal(c.rev, 8);
    assert.ok(c.ready);
  }
  assert.ok(c.apply({ ...snapshot, rev: 1, sessions: [] }));
  assert.equal(c.sessions.size, 0);
});

test('deep descendants stay in tree order at the last visible depth', () => {
  const agents = [{ kind: 'main', key: 'main' }];
  for (let i = 0; i < 12; i++) agents.push({ key: String(i), parent: agents.at(-1).key });
  const tree = store.agentTree({ agents });
  assert.deepEqual(tree.map((row) => row.agent), agents);
  assert.deepEqual(tree.map((row) => row.depth), agents.map((_, i) => Math.min(i, 8)));
});

test('large timelines respect both canvas limits without reducing normal density', () => {
  for (const [w, h] of [[1200, 9000], [300, 50000]]) {
    const ratio = canvasRatio(w, h, 3);
    assert.ok(ratio > 0 && Math.floor(w * ratio) * Math.floor(h * ratio) <= 16777216);
    assert.ok(Math.floor(h * ratio) <= 32767);
  }
  assert.equal(canvasRatio(600, 300, 2), 2);
});

test('agent durations prefer the current turn and never count inactive time as running', () => {
  const s = { ...session, feed: [{ kind: 'user', ts: 2000 }, { kind: 'agent', ts: 6000 }] };
  const main = { kind: 'main', startedAt: 0, display: 'running' };
  assert.equal(ranFor({ ...main, turnStartedAt: 8000 }, s, 10000), '2s');
  for (const a of [main, { ...main, turnStartedAt: null }]) assert.equal(ranFor(a, s, 10000), '8s');
  for (const display of ['idle', 'lost', 'unknown']) {
    assert.equal(ranFor({ kind: 'sub', startedAt: 0, lastActivityAt: 4000, display }, s, 10000), '');
  }
  assert.equal(ranFor({ kind: 'sub', startedAt: 0, display: 'done', endedAt: 4000 }, s, 10000), '4s');
});

test('failed details wake a frozen view once, and closing cancels the next wakeup', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let changes = 0;
  let requests = 0;
  const cache = createCallDetails({
    isConnected: () => true, onChange: () => changes++,
    fetchCall: async () => { requests++; throw new Error('offline'); },
  });
  const call = { id: 'tool', detail: 1 };
  cache.get(session, call);
  await new Promise((resolve) => setImmediate(resolve));
  const before = changes;
  cache.get(session, call);
  t.mock.timers.tick(5000);
  assert.equal(changes, before + 1);
  cache.get(session, call);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  cache.clear();
  const closed = changes;
  t.mock.timers.tick(10000);
  assert.equal(changes, closed);
});
