// DOM and formatting helpers. Text from the logs reaches the page through textContent only.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const ICONS = {
  shell: 'M4 6l5 5-5 5M12 17h8',
  read: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 1 0 0-5.6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M20 20l-4.8-4.8',
  web: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M3.5 9h17M3.5 15h17M12 3c-2.8 3-2.8 15 0 18M12 3c2.8 3 2.8 15 0 18',
  agent: 'M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 4v4M9.5 13.5v.5M14.5 13.5v.5',
  ask: 'M9 9a3 3 0 1 1 4.2 2.7c-.7.3-1.2 1-1.2 1.8v.5M12 18h.01',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  mcp: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0V8zM12 17v4',
  other: 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  close: 'M6 6l12 12M18 6L6 18',
};

export const CATEGORIES = ['shell', 'read', 'edit', 'search', 'web', 'agent', 'ask', 'data', 'mcp', 'other'];
export const CATEGORY_LABEL = {
  shell: 'Shell', read: 'Read', edit: 'Edit', search: 'Search', web: 'Web', agent: 'Agents', ask: 'Ask',
  data: 'Data', mcp: 'MCP', other: 'Other',
};

export function icon(category) {
  const s = svgEl('svg', {
    viewBox: '0 0 24 24', class: 'icon', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  s.append(svgEl('path', { d: ICONS[category] ?? ICONS.other }));
  return s;
}

export const ACTIVE = new Set(['running', 'starting', 'input', 'waiting']);
export const TERMINAL = new Set(['done', 'failed', 'cancelled', 'stopped']);
export const STATUS_LABEL = {
  running: 'running', starting: 'starting', input: 'needs answer', waiting: 'needs approval', idle: 'idle',
  done: 'done', failed: 'failed', cancelled: 'cancelled', stopped: 'stopped', orphan: 'lost',
  ok: 'ok', interrupted: 'interrupted', unknown: 'unknown',
};

export function hue(text) {
  let x = 7;
  for (const ch of String(text ?? '')) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

export function agentHue(a) {
  return a?.kind === 'main' ? 265 : hue(a?.type ?? a?.name ?? a?.key);
}

// CSS reads the hue of an agent from --h. CSSOM is allowed by the CSP; a style attribute is not.
export function setHue(el, a) {
  const v = String(agentHue(a));
  if (el.style.getPropertyValue('--h') !== v) el.style.setProperty('--h', v);
}

export function avatar(a, size) {
  const el = h('span', { class: size ? `avatar ${size}` : 'avatar', 'aria-hidden': 'true', text: initials(a) });
  setHue(el, a);
  return el;
}

export function initials(a) {
  if (a.kind === 'main') return 'M';
  const words = String(a.type ?? a.name ?? 'agent').split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

export function callState(c) {
  if (c.status === 'running') return c.perm ? 'needs approval' : 'running';
  if (c.status === 'ok') return c.endedAt != null && c.startedAt != null ? fmtDur(c.endedAt - c.startedAt) : 'ok';
  if (c.status === 'failed' && c.exitCode != null) return `exit ${c.exitCode}`;
  return STATUS_LABEL[c.status] ?? c.status;
}

// Everything that a call row shows, so that a list builds a row again only when it changes.
export const callSig = (c, a) => [c.status, c.startedAt, c.endedAt, c.perm, c.exitCode, c.name, c.summary, c.title, c.category, a?.name, a?.type].join('|');

export function callRow(c, a, onClick) {
  const what = c.summary ?? c.title ?? '';
  return h('button', {
    class: 'call', type: 'button', 'data-cat': c.category, 'data-status': c.status, onclick: () => onClick(c.id),
    title: [c.name, what, a?.name && `by ${a.name}`].filter(Boolean).join('\n'),
  }, a ? avatar(a, 'mini') : h('span'), icon(c.category),
  h('span', { class: 'call-text' }, h('span', { class: 'call-name', text: c.name }), ' ', what),
  h('span', { class: 'call-state', text: callState(c) }));
}

export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtAgo(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const two = (n) => String(n).padStart(2, '0');
export function fmtClock(ts, seconds = true) {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

export function setText(el, text) {
  const t = text ?? '';
  if (el.textContent !== t) el.textContent = t;
}

export function setData(el, key, value) {
  const v = value == null ? undefined : String(value);
  if (el.dataset[key] !== v) {
    if (v === undefined) delete el.dataset[key];
    else el.dataset[key] = v;
  }
}

// An update can replace or move the element that has focus, or that opened the detail panel.
// The replaced element names its successor, so focus can follow it to the new element.
const successors = new WeakMap();
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';

export function succeed(prev, next) {
  if (prev && next && prev !== next) successors.set(prev, next);
}

// The connected element that stands for `node`: the node itself, or the element at the same place
// in the successor of the node or of one of its ancestors. Null when the update dropped the node.
export function current(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.isConnected) return node;
  const path = [];
  for (let n = node; n; n = n.parentElement) {
    const next = successors.get(n);
    if (next) {
      const root = current(next, depth + 1);
      return root && counterpart(root, path);
    }
    if (n.parentElement) path.push([...n.parentElement.children].indexOf(n));
  }
  return null;
}

function counterpart(root, path) {
  let el = root;
  for (let i = path.length - 1; i >= 0 && el; i--) el = el.children[path[i]];
  if (el?.matches(FOCUSABLE)) return el;
  return root.matches(FOCUSABLE) ? root : root.querySelector(FOCUSABLE);
}

// Gives focus back to `node` or to its successor when an update took focus away from it.
export function restore(node) {
  if (!node) return;
  const at = document.activeElement;
  if (at === node || (at && at !== document.body)) return;
  current(node)?.focus({ preventScroll: true });
}

// moveBefore keeps the focus of a moved element; insertBefore drops it.
export function move(parent, el, before) {
  if (el.isConnected && parent.isConnected && parent.moveBefore) {
    try {
      parent.moveBefore(el, before);
      return;
    } catch {}
  }
  parent.insertBefore(el, before);
}

// Keeps one element per key in `parent`, in the order of `entries`. An entry whose `sig`
// changed is built again.
export function reconcile(parent, entries, cache, build) {
  const active = parent.contains(document.activeElement) ? document.activeElement : null;
  const keep = new Set(entries.map((e) => e.key));
  for (const [k, c] of cache) {
    if (keep.has(k)) continue;
    c.el.remove();
    cache.delete(k);
  }
  let i = 0;
  for (const e of entries) {
    let c = cache.get(e.key);
    if (!c || c.sig !== e.sig) {
      const el = build(e);
      if (c) {
        succeed(c.el, el);
        c.el.replaceWith(el);
      }
      c = { el, sig: e.sig };
      cache.set(e.key, c);
    }
    const at = parent.children[i];
    if (at !== c.el) move(parent, c.el, at ?? null);
    i++;
  }
  restore(active);
}
