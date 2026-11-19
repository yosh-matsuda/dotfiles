// The timeline: one lane per agent and one bar per tool call, drawn on a canvas.

import { agentTree, isLive } from './store.mjs';
import { ACTIVE, CATEGORIES, STATUS_LABEL, agentHue, callState, fmtClock, fmtDur, h, icon } from './ui.mjs';

const LANE = 22;
const AXIS = 22;
const LABEL = 132;
const PAD = 6;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120].map((m) => m * 60_000);
const HIDDEN_CALLS = new Set(['report_intent']);
const PROBES = ['fg', 'fg2', 'fg3', 'line', 'panel', 'panel2', 'purple', 'orange', 'red'];
const MOVE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

function windowLabel(minutes) {
  return minutes % 60 ? `${minutes} minutes` : minutes === 60 ? 'hour' : `${minutes / 60} hours`;
}

// The span of an agent: the main agent lives as long as its session.
function bandOf(a, s, now) {
  if (a.kind === 'main') {
    const start = s.meta.startedAt ?? a.startedAt;
    if (start == null) return null;
    return { start, end: s.meta.endedAt ?? (s.alive === false ? s.meta.lastEventAt ?? start : now) };
  }
  if (a.startedAt == null) return null;
  const open = ACTIVE.has(a.display) || a.display === 'idle';
  return { start: a.startedAt, end: a.endedAt ?? (open ? now : a.lastActivityAt ?? a.startedAt) };
}

// A call of a session whose process ended runs to the end of its log, faded.
const isOpen = (c) => c.status === 'running' || c.status === 'stopped';

function lanesOf(s, from, now) {
  const calls = new Map();
  for (const c of s.calls) {
    if (c.startedAt == null || HIDDEN_CALLS.has(c.name)) continue;
    const end = c.endedAt ?? (isOpen(c) ? now : c.startedAt);
    if (end < from) continue;
    if (!calls.has(c.agent)) calls.set(c.agent, []);
    calls.get(c.agent).push(c);
  }
  const lanes = [];
  for (const { agent, depth } of agentTree(s)) {
    const band = bandOf(agent, s, now);
    const own = (calls.get(agent.key) ?? []).sort((x, y) => x.startedAt - y.startedAt);
    if (own.length || (band && band.end >= from)) lanes.push({ agent, depth, band, calls: own });
  }
  return lanes;
}

export function createTimeline(canvas, wrap, tip, probe, say, { onFocusCall }) {
  const ctx = canvas.getContext('2d');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let colors = null;
  let last = null;
  let hits = [];
  let hover = null;
  let width = 0;
  let drawnEnd = 0;
  // The arrow keys move a cursor over the calls. keyFocus: the keyboard put focus on the canvas,
  // so the cursor shows a ring. keyed: the tip follows the cursor rather than the pointer.
  let cursor = null;
  let keyFocus = false;
  let keyed = false;
  let shownSid = null;

  function refreshColors() {
    if (!probe.childElementCount) {
      for (const c of CATEGORIES) probe.append(h('span', { 'data-cat': c }));
      for (const k of PROBES) probe.append(h('span', { class: `p-${k}` }));
    }
    const next = { cat: {} };
    for (const el of probe.children) {
      const color = getComputedStyle(el).color;
      if (el.dataset.cat) next.cat[el.dataset.cat] = color;
      else next[el.className.slice(2)] = color;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    next.dark = scheme === 'dark' || (scheme !== 'light' && dark.matches);
    next.font = getComputedStyle(document.body).fontFamily;
    colors = next;
    draw();
  }

  function fit(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo)}…`;
  }

  function box(x, y, w, hgt, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, Math.min(r, w / 2));
    else ctx.rect(x, y, w, hgt);
  }

  function draw() {
    if (!last || !colors) return;
    const { s, now, zoom } = last;
    if ((s?.id ?? null) !== shownSid) {
      shownSid = s?.id ?? null;
      cursor = null;
    }
    const w = wrap.clientWidth;
    if (!w) return;
    width = w;
    const span = zoom * 60_000;
    const live = Boolean(s) && isLive(s, now);
    // An ended session shows its own last minutes.
    const end = !s || live || s.stale ? now : Math.min(now, s.meta.lastEventAt ?? now);
    const from = end - span;
    drawnEnd = end;
    const lanes = s ? lanesOf(s, from, end) : [];
    const height = AXIS + Math.max(1, lanes.length) * LANE + PAD;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.textBaseline = 'middle';

    const plot = (w - LABEL - 8) * 0.97;
    const endX = LABEL + plot;
    const x = (t) => endX - ((end - t) / span) * plot;
    const bottom = height - PAD;

    // Lanes and the agent names.
    ctx.font = `12px ${colors.font}`;
    lanes.forEach((lane, i) => {
      const y = AXIS + i * LANE;
      if (i % 2) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = colors.panel2;
        ctx.fillRect(0, y, w, LANE);
        ctx.globalAlpha = 1;
      }
      const hue = agentHue(lane.agent);
      const indent = 10 + Math.min(lane.depth, 4) * 8;
      ctx.fillStyle = colors.dark ? `hsl(${hue}, 70%, 70%)` : `hsl(${hue}, 55%, 48%)`;
      ctx.beginPath();
      ctx.arc(indent, y + LANE / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.fg2;
      ctx.fillText(fit(lane.agent.name ?? 'agent', LABEL - indent - 16), indent + 9, y + LANE / 2 + 0.5);
      if (lane.band && lane.band.end >= from) {
        const x0 = Math.max(LABEL, x(lane.band.start));
        const x1 = Math.min(w - 2, x(lane.band.end));
        if (x1 > x0) {
          ctx.globalAlpha = colors.dark ? 0.2 : 0.16;
          ctx.fillStyle = `hsl(${hue}, 70%, ${colors.dark ? 62 : 52}%)`;
          box(x0, y + 5, x1 - x0, LANE - 10, 4);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    });

    // Calls older than the kept ones are gone; hatching marks where that starts.
    const cut = s?.truncatedBefore;
    if (lanes.length && cut != null && x(cut) > LABEL) {
      const x1 = Math.min(x(cut), endX);
      ctx.save();
      ctx.beginPath();
      ctx.rect(LABEL, AXIS, x1 - LABEL, bottom - AXIS);
      ctx.clip();
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = LABEL - (bottom - AXIS); k < x1; k += 7) {
        ctx.moveTo(k, bottom);
        ctx.lineTo(k + (bottom - AXIS), AXIS);
      }
      ctx.stroke();
      ctx.restore();
    }

    // The time axis.
    const step = TICK_STEPS.find((t) => (t / span) * plot >= 64) ?? TICK_STEPS.at(-1);
    const zone = new Date(end).getTimezoneOffset() * 60_000;
    ctx.font = `11px ${colors.font}`;
    ctx.textAlign = 'center';
    for (let t = Math.ceil((from - zone) / step) * step + zone; t <= end; t += step) {
      const tx = Math.round(x(t)) + 0.5;
      if (tx < LABEL + 14) continue;
      ctx.strokeStyle = colors.line;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(tx, AXIS - 3);
      ctx.lineTo(tx, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.fg3;
      ctx.fillText(fmtClock(t, false), tx, AXIS / 2);
    }
    ctx.textAlign = 'left';
    ctx.strokeStyle = colors.line;
    ctx.beginPath();
    ctx.moveTo(LABEL, AXIS - 0.5);
    ctx.lineTo(w, AXIS - 0.5);
    ctx.stroke();

    // The calls.
    const focused = last.focus?.type === 'call' ? last.focus.id : null;
    hits = [];
    lanes.forEach((lane, i) => {
      const y = AXIS + i * LANE + 4;
      const hgt = LANE - 8;
      for (const c of lane.calls) {
        const cEnd = c.endedAt ?? (isOpen(c) ? end : c.startedAt);
        let x0 = Math.max(LABEL, x(c.startedAt));
        let x1 = Math.min(w - 2, x(cEnd));
        if (x1 - x0 < 2) x1 = x0 + 2;
        if (x0 >= w - 2) continue;
        x0 = Math.round(x0 * 2) / 2;
        x1 = Math.round(x1 * 2) / 2;
        ctx.fillStyle = colors.cat[c.category] ?? colors.cat.other;
        ctx.globalAlpha = c.status === 'running' ? 1 : c.status === 'stopped' ? 0.45 : 0.85;
        box(x0, y, x1 - x0, hgt, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (c.status === 'failed' || c.status === 'interrupted') {
          ctx.fillStyle = colors.red;
          ctx.fillRect(x0, y + hgt - 2.5, x1 - x0, 2.5);
        }
        if (c.perm || c.id === focused) {
          ctx.strokeStyle = c.id === focused ? colors.fg : colors.orange;
          ctx.lineWidth = 1.5;
          box(x0 - 1, y - 1, x1 - x0 + 2, hgt + 2, 4);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        hits.push({ x0, x1, y0: y - 2, y1: y + hgt + 2, c, agent: lane.agent, lane: i });
      }
    });

    // The cursor stays on its call, or on a call near it when its call leaves the window.
    let cur = cursor && hits.find((hit) => hit.c.id === cursor.id);
    if (cursor && !cur) {
      cur = document.activeElement === canvas ? hits.find((hit) => hit.agent.key === cursor.agent) ?? newest() : null;
      cursor = cur ? { id: cur.c.id, agent: cur.agent.key } : null;
      if (cur && keyFocus) announce(cur);
    }
    if (cur && keyFocus && document.activeElement === canvas) {
      ctx.strokeStyle = colors.purple;
      ctx.lineWidth = 2;
      box(cur.x0 - 2.5, cur.y0 - 0.5, cur.x1 - cur.x0 + 5, cur.y1 - cur.y0 + 1, 5);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    if (live) {
      ctx.strokeStyle = colors.purple;
      ctx.fillStyle = colors.purple;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(endX, AXIS - 2);
      ctx.lineTo(endX, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(endX, AXIS - 3, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
    }

    if (!lanes.length) {
      ctx.fillStyle = colors.fg3;
      ctx.font = `12.5px ${colors.font}`;
      ctx.textAlign = 'center';
      ctx.fillText(s ? `No tool calls in the last ${windowLabel(zoom)}` : 'No session', LABEL + plot / 2, AXIS + LANE / 2 + 2);
      ctx.textAlign = 'left';
    }

    const count = lanes.reduce((n, l) => n + l.calls.length, 0);
    const where = live || !s ? `the last ${windowLabel(zoom)}` : `the ${windowLabel(zoom)} before ${fmtClock(end, false)}`;
    const label = `Tool calls in ${where}: ${count} ${count === 1 ? 'call' : 'calls'} by ${lanes.length} ${lanes.length === 1 ? 'agent' : 'agents'}`;
    if (canvas.getAttribute('aria-label') !== label) canvas.setAttribute('aria-label', label);
    showTip();
  }

  function newest() {
    return hits.reduce((best, hit) => (!best || hit.c.startedAt >= best.c.startedAt ? hit : best), null);
  }

  function hitAt(px, py) {
    let best = null;
    for (const hit of hits) {
      if (py < hit.y0 || py > hit.y1 || px < hit.x0 - 3 || px > hit.x1 + 3) continue;
      const inside = px >= hit.x0 && px <= hit.x1;
      if (!best || (inside && !best.inside) || (inside === best.inside && hit.c.startedAt >= best.hit.c.startedAt)) best = { hit, inside };
    }
    return best?.hit ?? null;
  }

  function facts({ c, agent }) {
    const state = c.status === 'running' ? callState(c) : STATUS_LABEL[c.status] ?? c.status;
    // A call without an end and not running has no known length.
    const open = c.endedAt == null && c.status !== 'running';
    const ran = c.startedAt == null || open ? '' : fmtDur((c.endedAt ?? drawnEnd) - c.startedAt);
    return [agent.name, state, ran, fmtClock(c.startedAt)].filter(Boolean);
  }

  function showTip() {
    let hit = hover && hitAt(hover.x, hover.y);
    canvas.style.cursor = hit ? 'pointer' : '';
    const pointer = Boolean(hit);
    if (!hit && keyed && cursor && document.activeElement === canvas) hit = hits.find((x) => x.c.id === cursor.id) ?? null;
    let bar = null;
    if (hit && !pointer) {
      const cr = canvas.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      bar = { left: cr.left + hit.x0, right: cr.left + hit.x1, top: cr.top + hit.y0, bottom: cr.top + hit.y1 };
      // The tip of a bar that the panel scrolled out of view would float over the other panels.
      if (bar.bottom < wr.top || bar.top > wr.bottom) hit = null;
    }
    if (!hit) {
      tip.hidden = true;
      return;
    }
    const { c } = hit;
    const title = h('div', { class: 'tip-title', 'data-cat': c.category }, icon(c.category), h('span', { text: c.name }));
    const what = c.summary ?? c.title;
    tip.replaceChildren(title, what ? h('div', { class: 'tip-text', text: what }) : '', h('div', { class: 'tip-meta', text: facts(hit).join(' · ') }));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = pointer ? hover.cx + 14 : bar.left;
    let top = pointer ? hover.cy + 16 : bar.bottom + 6;
    if (left + r.width > innerWidth - 8) left = Math.max(8, pointer ? hover.cx - r.width - 14 : bar.right - r.width);
    if (top + r.height > innerHeight - 8) top = Math.max(8, pointer ? hover.cy - r.height - 12 : bar.top - r.height - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function announce(hit) {
    const { c } = hit;
    const text = [c.name, c.summary ?? c.title, ...facts(hit)].filter(Boolean).join(', ');
    if (say.textContent !== text) say.textContent = text;
  }

  function reveal(hit) {
    const top = canvas.offsetTop + hit.y0 - AXIS;
    const bottom = canvas.offsetTop + hit.y1 + PAD;
    if (top < wrap.scrollTop) wrap.scrollTop = Math.max(0, top);
    else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
  }

  function moveTo(hit) {
    cursor = { id: hit.c.id, agent: hit.agent.key };
    hover = null;
    keyFocus = true;
    keyed = true;
    reveal(hit);
    draw();
    announce(hit);
  }

  // Left and Right step through the calls of a lane, Up and Down go to the call nearest in time
  // in the next lane that has calls, and Home and End go to the ends of the lane. An arrow at an
  // edge gives null.
  function step(cur, key) {
    const byLane = new Map();
    for (const hit of hits) {
      if (!byLane.has(hit.lane)) byLane.set(hit.lane, []);
      byLane.get(hit.lane).push(hit);
    }
    const row = byLane.get(cur.lane);
    const i = row.indexOf(cur);
    if (key === 'ArrowLeft') return row[i - 1] ?? null;
    if (key === 'ArrowRight') return row[i + 1] ?? null;
    if (key === 'Home') return row[0];
    if (key === 'End') return row.at(-1);
    const lanes = [...byLane.keys()].sort((x, y) => x - y);
    const other = byLane.get(lanes[lanes.indexOf(cur.lane) + (key === 'ArrowUp' ? -1 : 1)]);
    if (!other) return null;
    const mid = (cur.x0 + cur.x1) / 2;
    const gap = (x) => Math.abs((x.x0 + x.x1) / 2 - mid);
    return other.reduce((best, x) => (gap(x) < gap(best) ? x : best));
  }

  canvas.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = (cursor && hits.find((x) => x.c.id === cursor.id)) ?? null;
    if (e.key === 'Enter' || e.key === ' ') {
      if (!cur) return;
      e.preventDefault();
      onFocusCall(cur.c.id);
      return;
    }
    if (!MOVE_KEYS.has(e.key)) return;
    // Without calls, or at an edge, the arrow keys scroll the lanes as usual.
    const next = cur ? step(cur, e.key) : newest();
    if (!next) return;
    e.preventDefault();
    moveTo(next);
  });
  canvas.addEventListener('focus', () => {
    if (!cursor || !hits.some((x) => x.c.id === cursor.id)) {
      const hit = newest();
      cursor = hit ? { id: hit.c.id, agent: hit.agent.key } : null;
    }
    keyFocus = canvas.matches(':focus-visible');
    keyed = keyFocus;
    // A pointer that rests on the lanes would keep its tip over the tip of the cursor.
    if (keyFocus) hover = null;
    const cur = cursor && hits.find((x) => x.c.id === cursor.id);
    if (keyFocus && cur) announce(cur);
    draw();
  });
  canvas.addEventListener('blur', () => {
    keyFocus = false;
    keyed = false;
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = { x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY };
    keyed = false;
    showTip();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    showTip();
  });
  canvas.addEventListener('click', (e) => {
    const hit = hitAt(e.offsetX, e.offsetY);
    if (!hit) return;
    cursor = { id: hit.c.id, agent: hit.agent.key };
    onFocusCall(hit.c.id);
  });
  // The tip is fixed to the viewport, so a scroll of the lanes or of the page moves the bars
  // away from it.
  const onScroll = () => {
    hover = null;
    showTip();
  };
  wrap.addEventListener('scroll', onScroll, { passive: true });
  addEventListener('scroll', onScroll, { passive: true });
  new ResizeObserver(() => {
    if (wrap.clientWidth !== width) draw();
  }).observe(wrap);

  refreshColors();
  return {
    refreshColors,
    render(s, now, zoom, focus) {
      last = { s, now, zoom, focus };
      draw();
    },
  };
}
