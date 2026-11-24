// The list of sessions on the left.

import { sessionNow, sessionTitle, sparkline, wallNow } from './store.mjs';
import { fmtAgo, h, reconcile, setData, setText, shortPath, svgEl } from './ui.mjs';

const SPARK_MINUTES = 30;
const CLIENTS = { 'vscode-agent-host': 'VS Code', 'github/cli': 'CLI' };
const STATE_TEXT = { attention: 'needs attention', running: 'running', idle: 'idle', ended: 'ended' };

export function clientName(client) {
  if (!client) return null;
  return CLIENTS[client] ?? String(client).slice(0, 24);
}

export function placeOf(s) {
  const m = s.meta;
  if (m.repo) return m.branch ? `${m.repo} · ${m.branch}` : m.repo;
  return shortPath(m.cwd) || '';
}

// Bars of the calls per minute, scaled to the busiest minute.
function sparkPath(counts) {
  const max = Math.max(...counts);
  const w = 64 / counts.length;
  if (!max) return 'M0 17h64v1H0z';
  let d = '';
  counts.forEach((n, i) => {
    if (!n) return;
    const bar = Math.max(1.5, (n / max) * 17);
    d += `M${(i * w).toFixed(2)} 18h${(w - 0.6).toFixed(2)}v${(-bar).toFixed(2)}h${(0.6 - w).toFixed(2)}z`;
  });
  return d;
}

function badgesOf(s) {
  const out = [];
  if (s.hostName) out.push({ text: s.hostName });
  if (s.stale) out.push({ tone: 'orange', text: 'offline' });
  const client = clientName(s.client);
  if (client) out.push({ text: client });
  if (s.meta.batched) out.push({ tone: 'purple', text: 'auto', title: 'Copilot writes the work of an auto session when each turn ends' });
  const busy = s.agents.filter((a) => a.display === 'running' || a.display === 'starting').length;
  const asking = s.agents.filter((a) => a.display === 'input' || a.display === 'waiting').length;
  if (asking) out.push({ tone: 'orange', text: `${asking} waiting` });
  if (busy) out.push({ tone: 'green', text: `${busy} working` });
  return out;
}

export function createSessions(listEl, emptyEl, { onSelect }) {
  const cache = new Map();
  // Each row is built once and then changed in place, so a focused row keeps focus.
  const rows = new WeakMap();

  function build(sid) {
    const path = svgEl('path', { d: '' });
    const spark = svgEl('svg', { class: 'spark', viewBox: '0 0 64 18', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    spark.append(path);
    const p = {
      title: h('span', { class: 's-title' }), place: h('span', { class: 's-place' }),
      badges: h('span', { class: 's-badges', hidden: true }), sr: h('span', { class: 'sr' }), ago: h('span', { class: 's-ago' }),
      path, badgeSig: '[]',
    };
    p.button = h('button', { class: 'session', type: 'button', onclick: () => onSelect(sid) },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 's-main' }, p.title, p.place, p.badges, p.sr),
      h('span', { class: 's-side' }, p.ago, spark));
    const li = h('li', {}, p.button);
    rows.set(li, p);
    return li;
  }

  function update(p, s, now, minute) {
    if (p.session === s && p.minute === minute) return;
    p.session = s;
    p.minute = minute;
    setData(p.button, 'state', s.state);
    const title = sessionTitle(s);
    setText(p.title, title);
    setText(p.place, placeOf(s));
    const badges = badgesOf(s);
    const sig = JSON.stringify(badges);
    if (sig !== p.badgeSig) {
      p.badgeSig = sig;
      p.badges.replaceChildren(...badges.map((b) => h('span', { class: 'badge', 'data-tone': b.tone, title: b.title, text: b.text })));
      p.badges.hidden = !badges.length;
    }
    setText(p.sr, `, ${STATE_TEXT[s.state] ?? s.state}`);
    const d = sparkPath(sparkline(s, now, SPARK_MINUTES));
    if (p.path.getAttribute('d') !== d) p.path.setAttribute('d', d);
    const tip = [title, s.meta.cwd].filter(Boolean).join('\n');
    if (p.button.title !== tip) p.button.title = tip;
  }

  return {
    render(list, selected, now, { ready, total, filter, at }) {
      reconcile(listEl, list.map((s) => ({ key: s.id, sig: '', s })), cache, (e) => build(e.s.id));
      for (const s of list) {
        const clock = sessionNow(s, at);
        const p = rows.get(cache.get(s.id).el);
        update(p, s, clock, Math.floor(clock / 60_000));
        const current = s.id === selected ? 'true' : 'false';
        if (p.button.getAttribute('aria-current') !== current) p.button.setAttribute('aria-current', current);
        const event = s.meta.lastEventAt;
        setText(p.ago, event == null ? '' : fmtAgo(wallNow(s, now) - event));
      }
      let empty = '';
      if (!list.length) {
        if (!ready && !total) empty = 'Reading the session logs…';
        else if (total && filter === 'live') empty = 'No live sessions. Choose All to see the earlier ones.';
        else empty = 'No Copilot sessions yet. Start Copilot CLI, or agent mode in VS Code, and its sessions appear here.';
      }
      setText(emptyEl, empty);
      emptyEl.hidden = !empty;
    },
  };
}
