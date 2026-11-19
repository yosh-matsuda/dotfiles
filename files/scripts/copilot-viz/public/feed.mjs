// The activity feed of the selected session: messages, notes, and tool calls, oldest first.

import { avatar, callRow, callSig, fmtClock, h, reconcile } from './ui.mjs';

const KEEP = 220;
const NEAR_BOTTOM = 40;
// A task call shows as its agent, and an intent shows on the calls that follow it.
const HIDDEN_CALLS = new Set(['task', 'report_intent']);
const TAGS = { result: 'result', error: 'error', handoff: 'received' };
const NOTES = new Set(['notice', 'spawn', 'agent']);

export function createFeed(feedEl, jumpBtn, { onFocusAgent, onFocusCall }) {
  const cache = new Map();
  const empty = h('p', { class: 'empty', text: 'No activity yet.' });
  let shown;
  let stick = true;
  let lastKey = null;

  const nearBottom = () => feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < NEAR_BOTTOM;
  feedEl.addEventListener('scroll', () => {
    stick = nearBottom();
    if (stick) jumpBtn.hidden = true;
  }, { passive: true });
  jumpBtn.addEventListener('click', () => {
    stick = true;
    jumpBtn.hidden = true;
    feedEl.scrollTop = feedEl.scrollHeight;
  });

  function message(f, a) {
    const user = f.kind === 'user';
    const time = h('time', { class: 'msg-time', text: fmtClock(f.ts) });
    if (f.ts != null) time.dateTime = new Date(f.ts).toISOString();
    const name = user
      ? h('span', { class: 'msg-name', text: 'You' })
      : h('button', { class: 'msg-name', type: 'button', text: a?.name ?? 'agent', onclick: () => onFocusAgent(f.agent) });
    const head = h('div', { class: 'msg-head' }, name, TAGS[f.kind] ? h('span', { class: 'msg-tag', text: TAGS[f.kind] }) : null, time);
    return h('div', { class: 'msg', 'data-kind': f.kind },
      user || !a ? null : avatar(a, 'small'),
      h('div', {}, head, h('p', { class: 'msg-body', text: f.text })));
  }

  function note(f, a) {
    const text = f.kind === 'spawn' ? `Started ${f.text}` : f.text;
    return h('div', { class: 'note', 'data-kind': f.kind, title: `${fmtClock(f.ts)}  ${text}` },
      a ? avatar(a, 'mini') : null, h('span', { class: 'note-text', text }));
  }

  function reset() {
    cache.clear();
    feedEl.replaceChildren();
    stick = true;
    lastKey = null;
    jumpBtn.hidden = true;
  }

  return {
    render(s) {
      // A new epoch means the server rebuilt the session, so its feed IDs start over.
      const key = s ? `${s.id}\0${s.epoch}` : null;
      if (key !== shown) {
        reset();
        shown = key;
      }
      if (!s) return;
      const agents = new Map(s.agents.map((a) => [a.key, a]));
      const list = [];
      let ts = 0;
      for (const f of s.feed) {
        ts = f.ts ?? ts;
        list.push({ key: `f:${f.id}`, ts, f });
      }
      for (const c of s.calls) {
        if (!HIDDEN_CALLS.has(c.name) && c.startedAt != null) list.push({ key: `c:${c.id}`, ts: c.startedAt, c });
      }
      list.sort((x, y) => x.ts - y.ts);
      const entries = list.slice(-KEEP).map((e) => {
        const a = agents.get(e.f?.agent ?? e.c.agent);
        const sig = e.f ? [e.f.kind, e.f.agent, a?.name, a?.type].join('|') : callSig(e.c, a);
        return { ...e, a, sig };
      });

      if (!entries.length) {
        if (!empty.isConnected) {
          cache.clear();
          feedEl.replaceChildren(empty);
        }
        return;
      }
      empty.remove();
      const follow = stick;
      reconcile(feedEl, entries, cache, (e) => {
        if (e.c) return callRow(e.c, e.a, onFocusCall);
        return NOTES.has(e.f.kind) ? note(e.f, e.a) : message(e.f, e.a);
      });
      const newest = entries.at(-1).key;
      if (follow) feedEl.scrollTop = feedEl.scrollHeight;
      else if (newest !== lastKey) jumpBtn.hidden = false;
      lastKey = newest;
    },
  };
}
