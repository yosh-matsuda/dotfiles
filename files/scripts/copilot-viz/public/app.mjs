// The page: pairing, the stream, the view state, and the keys.

import { createDetail } from './detail.mjs';
import { createFeed } from './feed.mjs';
import { createMap } from './map.mjs';
import { createSessions } from './sessions.mjs';
import { activityIn, createStore, isLive, sessionNow, sessionTitle, sortSessions } from './store.mjs';
import { createTimeline } from './timeline.mjs';
import { CATEGORIES, CATEGORY_LABEL, fmtAgo, h, icon, reconcile, setData, setText } from './ui.mjs';

const TOKEN_KEY = 'copilot-viz-token';
const PREFS_KEY = 'copilot-viz-prefs';
const THEME_KEY = 'copilot-viz-theme';
const ZOOMS = [5, 15, 60, 360];
const ZOOM_KEYS = new Map([['1', 5], ['2', 15], ['3', 60], ['4', 360]]);
const REOPEN_MS = 3000;
// Follow moves only to a session that is more urgent than the one on screen.
const URGENCY = { attention: 0, running: 1 };
const CONN_TEXT = {
  connecting: 'Connecting…', loading: 'Reading logs…', live: 'Live', reconnecting: 'Reconnecting…',
  offline: 'Offline', unpaired: 'Not paired', refused: 'Refused',
};
const PAIR_TEXT = {
  'expired code': 'The pairing link expired. Run copilot-viz again to open a new one.',
  'unknown or used code': 'The pairing link was already used. Run copilot-viz again to open a new one.',
  'bad origin': 'The server pairs only with a page at 127.0.0.1 or localhost. Open the link that copilot-viz prints.',
  offline: 'The pairing request did not reach the server. Run copilot-viz again to open a new link.',
};
// "12s" in the session list counts seconds for the first minute after an event.
const SECONDS_MS = 65_000;

const $ = (id) => document.getElementById(id);
const el = {
  live: $('stat-live'), working: $('stat-working'), waiting: $('stat-waiting'), calls: $('stat-calls'),
  conn: $('conn'), theme: $('theme'), follow: $('follow'),
  overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayText: $('overlay-text'),
  overlayCmd: document.querySelector('.overlay-cmd'),
};
const filterButtons = [...document.querySelectorAll('[data-filter]')];
const zoomButtons = [...document.querySelectorAll('[data-zoom]')];
const behindOverlay = [document.querySelector('.top'), document.querySelector('.layout'), $('detail')];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the page still works until it is reloaded.
  }
}

function loadPrefs() {
  let p = null;
  try {
    p = JSON.parse(load(PREFS_KEY) ?? 'null');
  } catch {
    // The defaults below.
  }
  return { filter: p?.filter === 'all' ? 'all' : 'live', zoom: ZOOMS.includes(p?.zoom) ? p.zoom : 15, host: typeof p?.host === 'string' ? p.host : 'all' };
}

const store = createStore();
const view = { selected: null, follow: true, focus: null, ...loadPrefs() };
let synced = false;
let token = null;
let pairError = null;
let source = null;
let probing = null;
let reopenTimer = 0;
let conn = 'connecting';
let frame = 0;
let hostOptions = '';
const hostRows = new Map();

const sessions = createSessions($('session-list'), $('sessions-empty'), { onSelect: choose });
const map = createMap($('map'), $('session-head'), { onFocusAgent: focusAgent, onFocusCall: focusCall, onChange: schedule });
const timeline = createTimeline($('timeline'), $('timeline-wrap'), $('timeline-tip'), $('probe'), $('timeline-say'), { onFocusCall: focusCall });
const feed = createFeed($('feed'), $('feed-jump'), { onFocusAgent: focusAgent, onFocusCall: focusCall });
const detail = createDetail(
  { panel: $('detail'), title: $('detail-title'), body: $('detail-body'), close: $('detail-close'), cover: document.querySelector('.feed-panel') },
  { fetchCall, onClose: closeDetail, onFocusCall: focusCall, onChange: schedule },
);

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

// A second click on what the panel shows closes it.
function focusAgent(key) {
  view.focus = view.focus?.type === 'agent' && view.focus.key === key ? null : { type: 'agent', key };
  schedule();
}

function focusCall(id) {
  view.focus = view.focus?.type === 'call' && view.focus.id === id ? null : { type: 'call', id };
  schedule();
}

function closeDetail() {
  if (!view.focus) return;
  view.focus = null;
  schedule();
}

function choose(id) {
  if (id === view.selected) return;
  view.selected = id;
  view.focus = null;
  view.follow = false;
  syncControls();
  schedule();
}

// --- the view state ---------------------------------------------------------------------

function syncControls() {
  for (const b of filterButtons) b.setAttribute('aria-pressed', String(b.dataset.filter === view.filter));
  for (const b of zoomButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.zoom) === view.zoom));
  el.follow.setAttribute('aria-pressed', String(view.follow));
}

function savePrefs() {
  save(PREFS_KEY, JSON.stringify({ filter: view.filter, zoom: view.zoom, host: view.host }));
}

function setFilter(filter) {
  if (filter === view.filter) return;
  view.filter = filter;
  savePrefs();
  syncControls();
  schedule();
}

function setZoom(zoom) {
  if (zoom === view.zoom) return;
  view.zoom = zoom;
  savePrefs();
  syncControls();
  schedule();
}

function toggleFollow() {
  view.follow = !view.follow;
  // The open panel holds Follow back, so turning it on closes the panel.
  if (view.follow) view.focus = null;
  syncControls();
  schedule();
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : darkQuery.matches;
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = isDark();
  el.theme.replaceChildren(icon(dark ? 'sun' : 'moon'));
  el.theme.setAttribute('aria-label', dark ? 'Use the light theme' : 'Use the dark theme');
  timeline.refreshColors();
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  save(THEME_KEY, next);
  applyTheme(next);
}

function hashId() {
  try {
    return decodeURIComponent(location.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

// The hash names a pinned session, so a reload keeps both the session and Follow.
function syncHash() {
  const want = !view.follow && view.selected ? `#${encodeURIComponent(view.selected)}` : '';
  if (location.hash !== want) history.replaceState(history.state, '', `${location.pathname}${location.search}${want}`);
}

// The selected session stays in the list after it ends, until another one is chosen.
function visible(all, now) {
  return sortSessions(view.filter === 'all' ? all : all.filter((s) => s.id === view.selected || isLive(s, sessionNow(s, now))));
}

const inHost = (s) => view.host === 'all' || s.host === view.host;
const pinnedHost = () => [...store.hosts.values()].find((h) => h.remote && view.selected?.startsWith(`${h.name}/`));

function pick(shown) {
  const cur = view.selected ? store.sessions.get(view.selected) : undefined;
  // A session named by the hash may come later in the first read of the logs.
  if (view.selected && !cur && (!store.ready || (pinnedHost() && pinnedHost().state !== 'live'))) return false;
  const top = shown[0];
  let next = cur?.id ?? top?.id ?? null;
  // An open panel holds Follow back, so that the session does not change under the reader.
  if (cur && top && view.follow && !view.focus && (URGENCY[top.state] ?? 9) < (URGENCY[cur.state] ?? 9)) next = top.id;
  if (next === view.selected) return false;
  view.selected = next;
  view.focus = null;
  return true;
}

// --- rendering --------------------------------------------------------------------------

function stat(dd, n) {
  setText(dd, String(n));
  setData(dd.parentElement, 'on', n ? '' : null);
}

function counts(all, now) {
  const n = { live: 0, working: 0, waiting: 0, calls: 0, waitingSessions: 0 };
  for (const s of all) {
    if (!inHost(s) || s.stale) continue;
    const clock = sessionNow(s, now);
    n.calls += activityIn(s, clock, 5);
    if (!isLive(s, clock)) continue;
    n.live++;
    const before = n.waiting;
    for (const a of s.agents) {
      if (a.display === 'running' || a.display === 'starting') n.working++;
      else if (a.display === 'input' || a.display === 'waiting') n.waiting++;
    }
    if (n.waiting > before) n.waitingSessions++;
  }
  return n;
}

function renderStats(n) {
  stat(el.live, n.live);
  stat(el.working, n.working);
  stat(el.waiting, n.waiting);
  stat(el.calls, n.calls);
}

// A hidden tab runs no animation frames, so each message sets the title as well. The title counts
// the sessions that wait; the stats count their agents.
function renderTitle(waiting) {
  const s = view.selected ? store.sessions.get(view.selected) : undefined;
  const title = `${waiting ? `(${waiting} waiting) ` : ''}${s ? `${sessionTitle(s)} · ` : ''}Copilot Viz`;
  if (document.title !== title) document.title = title;
}

// A render each second only while the page shows seconds that count; otherwise one a minute.
// The timeline of a live session ends at the present, so it moves each second.
function needsTick(now) {
  const cur = view.selected ? store.sessions.get(view.selected) : undefined;
  if (cur && (isLive(cur, sessionNow(cur, now)) || cur.shells.some((sh) => sh.status === 'running'))) return true;
  if ([...store.hosts.values()].some((h) => h.retryAt > now)) return true;
  for (const s of store.sessions.values()) {
    if (s.state === 'running' || s.state === 'attention') return true;
    if (!s.stale && s.meta.lastEventAt != null && sessionNow(s, now) - s.meta.lastEventAt < SECONDS_MS) return true;
  }
  return false;
}

function mapEmpty(all, shown) {
  if (!synced) return 'Connecting…';
  const host = pinnedHost();
  if (host && !store.sessions.has(view.selected) && host.state !== 'live') return `Waiting for ${host.name}. Other hosts remain available.`;
  if (view.selected && !store.sessions.has(view.selected) && !store.ready) return 'Reading the session logs…';
  if (!all.length) return store.ready ? 'No Copilot sessions yet.' : 'Reading the session logs…';
  return shown.length ? 'Choose a session.' : 'No live sessions right now.';
}

function renderHosts(now, s) {
  const hosts = [...store.hosts.values()];
  $('host-controls').hidden = hosts.length < 2;
  const sig = JSON.stringify(hosts.map((h) => [h.id, h.name]));
  if (sig !== hostOptions) {
    hostOptions = sig;
    $('host-filter').replaceChildren(h('option', { value: 'all', text: 'All hosts' }),
      ...hosts.map((host) => h('option', { value: host.id, text: `${host.name}${host.remote ? '' : ' (local)'}` })));
  }
  $('host-filter').value = view.host;
  const entries = hosts.map((host) => {
    const seen = host.lastSeen == null ? '' : `Last received ${fmtAgo(now - host.lastSeen)} ago.`;
    const retry = host.retryAt ? `Retry in ${Math.max(0, Math.ceil((host.retryAt - now) / 1000))}s.` : '';
    const note = host.state === 'offline' ? [host.error, seen, retry].filter(Boolean).join(' ') : '';
    return { key: host.id, sig: `${host.state}|${note}`, host, note };
  });
  reconcile($('host-list'), entries, hostRows, ({ host, note }) => h('li', { 'data-state': host.state },
    h('span', { text: host.name }), ' ', h('span', { class: 'host-state', text: host.state }),
    note ? h('p', { class: 'host-error', text: note }) : null));
  const host = s ? store.hosts.get(s.host) : pinnedHost();
  const warning = host?.remote && host.state !== 'live'
    ? `${host.name}: ${host.state}. ${s ? 'Showing the last received state; current activity is unknown.' : 'Waiting for session data.'}` : '';
  setText($('host-warning'), warning);
  $('host-warning').hidden = !warning;
}

function render() {
  frame = 0;
  const now = store.now();
  if (synced && view.host !== 'all' && !store.hosts.has(view.host)) view.host = 'all';
  const all = [...store.sessions.values()].filter(inHost);
  let shown = visible(all, now);
  if (synced && pick(shown)) shown = visible(all, now);
  syncHash();
  const s = (view.selected && store.sessions.get(view.selected)) || null;
  const clock = sessionNow(s, now);

  renderHosts(now, s);
  sessions.render(shown, view.selected, now, { ready: store.ready, total: all.length, filter: view.filter });
  map.render(s, clock, view.focus, mapEmpty(all, shown));
  timeline.render(s, clock, view.zoom, view.focus);
  feed.render(s, clock);
  detail.render(s, view.focus, clock);

  const n = counts(all, now);
  renderStats(n);
  renderTitle(n.waitingSessions);
}

// --- the connection ---------------------------------------------------------------------

function setConn(state) {
  conn = state;
  setData(el.conn, 'state', state === 'refused' ? 'offline' : state);
  setText(el.conn, CONN_TEXT[state]);
}

function showOverlay(title, text, command = true) {
  setText(el.overlayTitle, title);
  setText(el.overlayText, text);
  el.overlayCmd.hidden = !command;
  if (!el.overlay.hidden) return;
  el.overlay.hidden = false;
  for (const e of behindOverlay) e.inert = true;
  el.overlayTitle.focus();
}

function hideOverlay() {
  if (el.overlay.hidden) return;
  el.overlay.hidden = true;
  for (const e of behindOverlay) e.inert = false;
}

function closeSource() {
  clearTimeout(reopenTimer);
  reopenTimer = 0;
  source?.close();
  source = null;
}

function unpaired() {
  closeSource();
  setConn('unpaired');
  showOverlay('Not paired', PAIR_TEXT[pairError] ?? 'This page has no key for the running server. Run copilot-viz to open a paired page.');
}

function connect() {
  closeSource();
  if (!token) return unpaired();
  if (conn !== 'offline' && conn !== 'reconnecting') setConn('connecting');
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  source = es;
  es.onopen = () => {
    if (source !== es) return;
    // The server opens the stream only for its token, so the error of an earlier pairing is over.
    pairError = null;
    hideOverlay();
  };
  es.onmessage = (e) => {
    if (source !== es) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    // The rows of a new server's sessions differ by epoch, so they are patched, not built again.
    if (msg?.type === 'snapshot') synced = true;
    store.apply(msg);
    renderTitle(counts(store.sessions.values(), store.now()).waitingSessions);
    hideOverlay();
    setConn(store.ready ? 'live' : 'loading');
    schedule();
  };
  es.onerror = () => {
    if (source === es) probe(es);
  };
  return undefined;
}

// EventSource does not tell why it failed; a request with the token does.
async function probe(es) {
  if (probing === es) return;
  probing = es;
  let status = 0;
  try {
    status = (await fetch('/api/call?sid=-&id=-', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })).status;
  } catch {
    // The server is not running.
  }
  if (probing === es) probing = null;
  if (source !== es) return;
  if (status === 401) {
    unpaired();
    return;
  }
  if (status === 403) {
    closeSource();
    setConn('refused');
    showOverlay('Access refused', 'The server serves only the user that started it, at 127.0.0.1 or localhost. Open the link that copilot-viz prints.', false);
    return;
  }
  if (es.readyState === EventSource.OPEN) return;
  if (status === 0) {
    setConn('offline');
    showOverlay('Server not running', 'The copilot-viz server stopped. Run copilot-viz to start it again.');
  } else {
    setConn('reconnecting');
  }
  // A browser retries a stream that is CONNECTING, but not one that it closed.
  if (es.readyState === EventSource.CLOSED && !reopenTimer) {
    reopenTimer = setTimeout(() => {
      reopenTimer = 0;
      if (source === es) connect();
    }, REOPEN_MS);
  }
}

async function fetchCall(sid, id, epoch) {
  const r = await fetch(`/api/call?sid=${encodeURIComponent(sid)}&id=${encodeURIComponent(id)}&epoch=${encodeURIComponent(epoch)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    if (r.status === 401 && source) probe(source);
    const body = await r.json();
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

// A pairing code works once, so it leaves the address before it is sent.
async function pair() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return { token: load(TOKEN_KEY) };
  url.searchParams.delete('code');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  try {
    const r = await fetch('/api/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store',
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok && typeof body.token === 'string' && body.token) {
      save(TOKEN_KEY, body.token);
      return { token: body.token };
    }
    return { token: load(TOKEN_KEY), error: typeof body.error === 'string' ? body.error : null };
  } catch {
    return { token: load(TOKEN_KEY), error: 'offline' };
  }
}

// --- events -----------------------------------------------------------------------------

$('host-filter').addEventListener('change', (e) => {
  view.host = e.target.value;
  view.selected = null;
  view.focus = null;
  savePrefs();
  schedule();
});
for (const b of filterButtons) b.addEventListener('click', () => setFilter(b.dataset.filter === 'all' ? 'all' : 'live'));
for (const b of zoomButtons) b.addEventListener('click', () => setZoom(Number(b.dataset.zoom)));
el.follow.addEventListener('click', toggleFollow);
el.theme.addEventListener('click', toggleTheme);
darkQuery.addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));

addEventListener('keydown', (e) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || !el.overlay.hidden) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
  // The VS Code integrated browser marks Escape as handled before the page sees it.
  if (e.key === 'Escape') {
    if (!view.focus) return;
    closeDetail();
  } else if (e.defaultPrevented) return;
  else if (e.key === 'f') toggleFollow();
  else if (e.key === 't') toggleTheme();
  else if (ZOOM_KEYS.has(e.key)) setZoom(ZOOM_KEYS.get(e.key));
  else return;
  e.preventDefault();
});

addEventListener('hashchange', () => {
  const id = hashId();
  if (!id || id === view.selected) return;
  view.selected = id;
  view.host = 'all';
  view.focus = null;
  view.follow = false;
  syncControls();
  schedule();
});

// Another tab that pairs with a new server shares its token with this one.
addEventListener('storage', (e) => {
  if (e.key === TOKEN_KEY && e.newValue && e.newValue !== token) {
    token = e.newValue;
    pairError = null;
    connect();
  } else if (e.key === THEME_KEY) {
    applyTheme(e.newValue);
  }
});

// --- start ------------------------------------------------------------------------------

$('detail-close').replaceChildren(icon('close'));
$('legend').replaceChildren(
  ...CATEGORIES.map((c) => h('span', { 'data-cat': c, text: CATEGORY_LABEL[c] })),
  h('span', { 'data-phase': 'idle', text: 'Idle' }),
  h('span', { 'data-phase': 'thinking', text: 'Response pending (inferred)' }),
  h('span', { 'data-phase': 'waiting', text: 'Waiting for input or approval' }),
);
applyTheme(load(THEME_KEY));
const pinned = hashId();
if (pinned) {
  view.selected = pinned;
  view.host = 'all';
  view.follow = false;
}
syncControls();
setConn('connecting');
schedule();
let tickMinute = -1;
setInterval(() => {
  const now = store.now();
  const minute = Math.floor(now / 60_000);
  if (minute === tickMinute && !needsTick(now)) return;
  tickMinute = minute;
  schedule();
}, 1000);
pair().then((r) => {
  token = r.token;
  pairError = r.error ?? null;
  connect();
});
