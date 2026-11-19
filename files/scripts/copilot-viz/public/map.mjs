// The agent map: the main agent on top and each subagent in a row under the agent that
// launched it. Agents at work get a card; finished ones shrink to a chip.

import { clientName } from './sessions.mjs';
import { agentTree, isQuiet, sessionTitle } from './store.mjs';
import { ACTIVE, STATUS_LABEL, TERMINAL, fmtAgo, fmtDur, fmtTokens, h, icon, initials, move, restore, setData, setHue, setText, succeed, svgEl } from './ui.mjs';

const CHIP_LIMIT = 14;
const ENDED_SHELLS = 6;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const isChip = (a) => a.kind !== 'main' && (TERMINAL.has(a.display) || a.display === 'orphan');

// Markdown marks that a three-line bubble cannot show.
export function plain(md) {
  return String(md)
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}[-:| ]*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Moves the children of `parent` into the order of `els` and removes the others.
function place(parent, els) {
  els.forEach((el, i) => {
    const at = parent.children[i];
    if (at !== el) move(parent, el, at ?? null);
  });
  while (parent.children.length > els.length) parent.lastElementChild.remove();
}

// Offsets ignore transforms, so a card that lifts on hover keeps its edges.
function boxIn(el, root) {
  let x = 0;
  let y = 0;
  for (let n = el; n && n !== root; n = n.offsetParent) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function startOf(a, s) {
  if (a.startedAt != null) return a.startedAt;
  if (a.kind !== 'main') return null;
  return s.meta.startedAt ?? s.calls.find((c) => c.agent === 'main')?.startedAt ?? null;
}

function since(ts, now) {
  const ago = ts == null ? '' : fmtAgo(now - ts);
  if (!ago) return '';
  return ago === 'now' ? 'just now' : `${ago} ago`;
}

function durationText(a, s, now) {
  if (ACTIVE.has(a.display)) {
    // The log has no start of a turn of the main agent; its newest prompt starts one.
    const from = a.kind === 'main' ? s.feed.findLast((f) => f.kind === 'user')?.ts ?? startOf(a, s) : startOf(a, s);
    return from == null ? '' : fmtDur(now - from);
  }
  if (a.kind === 'main' || a.display === 'idle') return since(a.lastActivityAt, now);
  if (a.durationMs != null) return fmtDur(a.durationMs);
  const from = startOf(a, s);
  const to = a.endedAt ?? a.lastActivityAt;
  return from != null && to != null ? fmtDur(to - from) : '';
}

function stateText(a, quiet) {
  if (a.compacting && ACTIVE.has(a.display)) return 'compacting';
  if (quiet) return 'quiet';
  return STATUS_LABEL[a.display] ?? a.display;
}

function subText(a, s) {
  if (a.kind === 'main') return [a.model ?? s.meta.model, a.effort ?? s.meta.effort].filter(Boolean).join(' · ');
  return a.description ?? [a.type !== a.name ? a.type : null, a.model].filter(Boolean).join(' · ');
}

function metaItems(a) {
  const out = [];
  if (a.kind !== 'main' && a.model && a.description) out.push(a.model);
  if (a.kind !== 'main' && a.mode === 'background') out.push('background');
  const tokens = a.reportedTokens ?? a.tokens.input + a.tokens.output;
  if (tokens) out.push(`${fmtTokens(tokens)} tokens`);
  if (a.toolCount) out.push(a.toolCount === 1 ? '1 tool call' : `${a.toolCount} tool calls`);
  return out;
}

function createCard(key, on) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('button', { class: 'card-name', type: 'button' });
  const sub = h('span', { class: 'card-sub' });
  const state = h('span', { class: 'state' });
  const dur = h('span', { class: 'card-dur' });
  let toolIcon = icon('other');
  const toolName = h('span', { class: 'tool-name' });
  const toolSummary = document.createTextNode('');
  const toolTime = h('span', { class: 'tool-time' });
  const tool = h('button', { class: 'tool', type: 'button', hidden: true },
    toolIcon, h('span', { class: 'tool-text' }, toolName, ' ', toolSummary), toolTime, h('span', { class: 'tool-bar', 'aria-hidden': 'true' }));
  const bubbleText = h('p', { class: 'bubble-text' });
  const bubbleAgo = h('span', { class: 'bubble-ago' });
  const bubble = h('div', { class: 'bubble', hidden: true }, bubbleText, bubbleAgo);
  const meta = h('div', { class: 'card-meta' });
  const el = h('article', { class: 'card' },
    h('div', { class: 'card-top' }, avatar, h('div', { class: 'card-id' }, name, sub), h('div', { class: 'card-status' }, state, dur)),
    tool, bubble, meta);

  let callId = null;
  let category = 'other';
  let messageAt;
  let metaSig = null;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.tool')) {
      if (callId) on.onFocusCall(callId);
      return;
    }
    // A drag that selects text in the bubble is not a click on the card.
    if (!e.target.closest('button') && String(getSelection() ?? '')) return;
    on.onFocusAgent(key);
  });

  function update(a, s, now, ctx) {
    const quiet = isQuiet(a, s, now);
    setData(el, 'kind', a.kind);
    setData(el, 'display', a.display);
    setData(el, 'quiet', quiet ? '' : null);
    setData(el, 'focused', ctx.focused === a.key ? '' : null);
    setData(el, 'placeholder', a.placeholder ? '' : null);
    setHue(el, a);
    setText(avatar, initials(a));
    setText(name, a.name ?? 'agent');
    name.title = [a.name, a.type, a.description].filter(Boolean).join('\n');
    setText(sub, subText(a, s));
    setText(state, stateText(a, quiet));
    state.title = quiet ? `No events for ${fmtAgo(now - a.lastActivityAt)}` : '';
    setText(dur, durationText(a, s, now));

    const c = a.current ? ctx.calls.get(a.current) : undefined;
    tool.hidden = !c;
    callId = c?.id ?? null;
    if (c) {
      if (c.category !== category) {
        category = c.category;
        const next = icon(category);
        toolIcon.replaceWith(next);
        toolIcon = next;
      }
      setData(tool, 'cat', c.category);
      setData(tool, 'status', c.status);
      setData(tool, 'perm', c.perm ? '' : null);
      setText(toolName, c.name);
      const what = c.summary ?? c.title ?? '';
      if (toolSummary.data !== what) toolSummary.data = what;
      // A call of a session whose process ended never reports its end.
      const stopped = c.status !== 'running';
      const note = stopped ? `${STATUS_LABEL[c.status] ?? c.status}: the Copilot process ended` : c.perm ? 'Needs approval' : null;
      tool.title = [note, c.name, what].filter(Boolean).join('\n');
      const more = a.running > 1 ? `+${a.running - 1} · ` : '';
      setText(toolTime, stopped ? STATUS_LABEL[c.status] ?? c.status : more + (c.startedAt == null ? '' : fmtDur(now - c.startedAt)));
    }

    bubble.hidden = !a.lastMessage;
    if (a.lastMessage) {
      setText(bubbleText, plain(a.lastMessage));
      setText(bubbleAgo, since(a.lastMessageAt, now));
    }
    if (a.lastMessageAt !== messageAt) {
      if (messageAt !== undefined && a.lastMessage && !reducedMotion.matches) {
        bubble.animate([
          { transform: 'scale(.94)', opacity: 0.35, transformOrigin: '22px 0' },
          { transform: 'none', opacity: 1, transformOrigin: '22px 0' },
        ], { duration: 280, easing: 'cubic-bezier(.2, .9, .3, 1.25)' });
      }
      messageAt = a.lastMessageAt;
    }

    const items = metaItems(a);
    const sig = items.join('\u0000');
    if (sig !== metaSig) {
      metaSig = sig;
      meta.replaceChildren(...items.map((text) => h('span', { text })));
    }
  }
  return { el, update };
}

function createChip(key, on) {
  const avatar = h('span', { class: 'avatar mini', 'aria-hidden': 'true' });
  const name = h('span', { class: 'chip-name' });
  const status = h('span', { class: 'chip-status' });
  const el = h('button', { class: 'chip', type: 'button', onclick: () => on.onFocusAgent(key) }, avatar, name, status);
  function update(a, s, now, ctx) {
    setData(el, 'display', a.display);
    setData(el, 'focused', ctx.focused === a.key ? '' : null);
    setHue(el, a);
    setText(avatar, initials(a));
    setText(name, a.name ?? 'agent');
    const dur = durationText(a, s, now);
    setText(status, [STATUS_LABEL[a.display] ?? a.display, dur].filter(Boolean).join(' · '));
    el.title = [a.name, a.description].filter(Boolean).join('\n');
  }
  return { el, update };
}

function shellStatus(sh, now) {
  const took = sh.startedAt != null && sh.endedAt != null ? fmtDur(sh.endedAt - sh.startedAt) : '';
  let parts;
  if (sh.status === 'running') parts = ['running', sh.startedAt == null ? '' : fmtDur(now - sh.startedAt)];
  else if (sh.status === 'done') parts = [sh.exitCode != null ? `exit ${sh.exitCode}` : 'finished', took];
  else if (sh.status === 'unknown') parts = ['end unknown'];
  else parts = [STATUS_LABEL[sh.status] ?? sh.status, took];
  return parts.filter(Boolean).join(' · ');
}

// A shell opens the call that started it while the session still keeps that call.
function createShell(sh, open, on) {
  const avatar = h('span', { class: 'avatar mini', 'aria-hidden': 'true' });
  const label = h('span', { class: 'chip-name' });
  const status = h('span', { class: 'chip-status' });
  const kids = [avatar, icon('shell'), label, status];
  const el = open
    ? h('button', { class: 'chip shell', type: 'button', 'data-cat': 'shell', onclick: () => on.onFocusCall(sh.callId) }, kids)
    : h('span', { class: 'chip shell', 'data-cat': 'shell' }, kids);
  function update(x, now, owner) {
    setData(el, 'status', x.status);
    setData(el, 'failed', x.exitCode != null && x.exitCode !== 0 ? '' : null);
    avatar.hidden = !owner;
    if (owner) {
      setHue(avatar, owner);
      setText(avatar, initials(owner));
    }
    setText(label, x.description ?? x.command ?? `shell ${x.id}`);
    setText(status, shellStatus(x, now));
    el.title = [x.description, x.command, `shell ${x.id}`, owner && `by ${owner.name}`].filter(Boolean).join('\n');
  }
  return { el, open, update };
}

export function createMap(mapEl, headEl, on) {
  const edges = svgEl('svg', { class: 'edges', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'map-inner' }, edges);
  const empty = h('p', { class: 'empty' });
  mapEl.append(inner, empty);
  const headTitle = h('span', { class: 'sh-title' });
  const headBadges = h('span', { class: 'sh-badges' });
  headEl.append(headTitle, headBadges);
  const shellList = h('div', { class: 'shell-list' });
  const shellsEl = h('section', { class: 'shells', 'aria-labelledby': 'shells-title' },
    h('h3', { id: 'shells-title', text: 'Background shells' }), shellList);

  let sid = null;
  let headSig = null;
  let lines = [];
  const cards = new Map();
  const chips = new Map();
  const shells = new Map();
  const rows = new Map();
  const paths = new Map();
  const expanded = new Set();

  function row(depth) {
    let r = rows.get(depth);
    if (!r) {
      const more = h('button', { class: 'more', type: 'button', onclick: () => {
        if (expanded.has(depth)) expanded.delete(depth);
        else expanded.add(depth);
        on.onChange();
      } });
      r = { el: h('div', { class: 'row' }), chips: h('div', { class: 'chips' }), more };
      rows.set(depth, r);
    }
    return r;
  }

  function drawEdges() {
    const seen = new Set();
    const els = [];
    for (const line of lines) {
      if (!line.from.isConnected || !line.to.isConnected) continue;
      const p = boxIn(line.from, inner);
      const c = boxIn(line.to, inner);
      const x1 = p.x + p.w / 2;
      const y1 = p.y + p.h;
      const x2 = c.x + c.w / 2;
      const y2 = c.y;
      const bend = Math.max(14, (y2 - y1) / 2);
      const d = `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
      let path = paths.get(line.key);
      if (!path) {
        path = svgEl('path', { class: 'edge' });
        paths.set(line.key, path);
      }
      if (path.getAttribute('d') !== d) path.setAttribute('d', d);
      setData(path, 'active', ACTIVE.has(line.agent.display) ? '' : null);
      setData(path, 'faint', isChip(line.agent) ? '' : null);
      setHue(path, line.agent);
      seen.add(line.key);
      els.push(path);
    }
    for (const [k, path] of paths) {
      if (!seen.has(k)) {
        path.remove();
        paths.delete(k);
      }
    }
    place(edges, els);
  }
  new ResizeObserver(() => drawEdges()).observe(inner);

  function renderHead(s) {
    const badges = [];
    if (s) {
      if (s.hostName) badges.push([s.stale ? 'orange' : null, s.hostName]);
      const model = s.agents.find((a) => a.kind === 'main')?.model ?? s.meta.model;
      if (model) badges.push(['purple', model]);
      if (s.meta.mode && s.meta.mode !== 'interactive') badges.push(['orange', s.meta.mode]);
      const client = clientName(s.client);
      if (client) badges.push([null, client]);
      if (s.meta.aic != null) badges.push([null, `${s.meta.aic < 10 ? s.meta.aic.toFixed(2) : s.meta.aic.toFixed(1)} AI credits`]);
      else if (s.meta.premium != null) badges.push([null, `${s.meta.premium} premium requests`]);
    }
    setText(headTitle, s ? sessionTitle(s) : '');
    headTitle.title = s ? [sessionTitle(s), s.meta.cwd, s.meta.branch && `branch ${s.meta.branch}`].filter(Boolean).join('\n') : '';
    const sig = JSON.stringify(badges);
    if (sig === headSig) return;
    headSig = sig;
    headBadges.replaceChildren(...badges.map(([tone, text]) => h('span', { class: 'badge', 'data-tone': tone, text })));
  }

  // Running shells first, then the newest ones that ended. Returns whether any shows.
  function renderShells(s, now, calls, agents) {
    const running = s.shells.filter((x) => x.status === 'running').sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));
    const ended = s.shells.filter((x) => x.status !== 'running')
      .sort((x, y) => (y.endedAt ?? y.startedAt ?? 0) - (x.endedAt ?? x.startedAt ?? 0)).slice(0, ENDED_SHELLS);
    const els = [];
    const seen = new Set();
    for (const sh of [...running, ...ended]) {
      const open = sh.callId != null && calls.has(sh.callId);
      let v = shells.get(sh.id);
      if (!v || v.open !== open) {
        const next = createShell(sh, open, on);
        if (v) succeed(v.el, next.el);
        v = next;
        shells.set(sh.id, v);
      }
      v.update(sh, now, agents.get(sh.agent));
      els.push(v.el);
      seen.add(sh.id);
    }
    for (const k of shells.keys()) if (!seen.has(k)) shells.delete(k);
    place(shellList, els);
    return els.length > 0;
  }

  function reset() {
    cards.clear();
    chips.clear();
    shells.clear();
    rows.clear();
    paths.clear();
    expanded.clear();
    lines = [];
    headSig = null;
    inner.replaceChildren(edges);
    edges.replaceChildren();
    shellList.replaceChildren();
  }

  return {
    render(s, now, focus, emptyText) {
      if ((s?.id ?? null) !== sid) {
        reset();
        sid = s?.id ?? null;
      }
      renderHead(s);
      inner.hidden = !s;
      empty.hidden = Boolean(s);
      if (!s) {
        setText(empty, emptyText);
        lines = [];
        return;
      }
      const active = inner.contains(document.activeElement) ? document.activeElement : null;

      const calls = new Map(s.calls.map((c) => [c.id, c]));
      const focused = focus?.type === 'agent' ? focus.key : focus?.type === 'call' ? calls.get(focus.id)?.agent ?? null : null;
      const ctx = { calls, focused };
      const tree = agentTree(s);
      const byKey = new Map(tree.map(({ agent }) => [agent.key, agent]));
      const byDepth = new Map();
      for (const { agent, depth } of tree) {
        if (!byDepth.has(depth)) byDepth.set(depth, []);
        byDepth.get(depth).push(agent);
      }

      const shown = new Map();
      const usedCards = new Set();
      const usedChips = new Set();
      const rowEls = [];
      for (const [depth, agents] of [...byDepth].sort((x, y) => x[0] - y[0])) {
        const r = row(depth);
        const done = agents.filter(isChip);
        let hidden = new Set();
        if (done.length > CHIP_LIMIT && !expanded.has(depth)) {
          const newest = [...done].sort((x, y) => (y.endedAt ?? y.startedAt ?? 0) - (x.endedAt ?? x.startedAt ?? 0));
          hidden = new Set(newest.slice(CHIP_LIMIT).map((a) => a.key));
        }
        const cardEls = [];
        const chipEls = [];
        for (const a of agents) {
          if (hidden.has(a.key)) continue;
          const chip = isChip(a);
          const pool = chip ? chips : cards;
          let v = pool.get(a.key);
          if (!v) {
            v = chip ? createChip(a.key, on) : createCard(a.key, on);
            pool.set(a.key, v);
            // Focus on the card of an agent that ends moves to its chip, and back when it runs again.
            const before = (chip ? cards : chips).get(a.key);
            if (before) succeed(before.el, v.el);
          }
          (chip ? usedChips : usedCards).add(a.key);
          v.update(a, s, now, ctx);
          (chip ? chipEls : cardEls).push(v.el);
          shown.set(a.key, v.el);
        }
        const extra = done.length - CHIP_LIMIT;
        if (extra > 0) {
          setText(r.more, expanded.has(depth) ? 'Show fewer' : `+${hidden.size} earlier`);
          r.more.setAttribute('aria-expanded', String(expanded.has(depth)));
          chipEls.unshift(r.more);
        }
        place(r.chips, chipEls);
        place(r.el, chipEls.length ? [...cardEls, r.chips] : cardEls);
        rowEls.push(r.el);
      }
      for (const [k] of cards) if (!usedCards.has(k)) cards.delete(k);
      for (const [k] of chips) if (!usedChips.has(k)) chips.delete(k);
      const hasShells = renderShells(s, now, calls, byKey);
      place(inner, hasShells ? [edges, ...rowEls, shellsEl] : [edges, ...rowEls]);

      lines = [];
      for (const { agent } of tree) {
        if (agent.kind === 'main') continue;
        const to = shown.get(agent.key);
        if (!to) continue;
        // A parent hidden among the earlier chips hands its edge to the nearest shown ancestor.
        let p = byKey.has(agent.parent) ? agent.parent : 'main';
        while (!shown.has(p) && p !== 'main') p = byKey.has(byKey.get(p)?.parent) ? byKey.get(p).parent : 'main';
        const from = shown.get(p);
        if (from) lines.push({ key: agent.key, from, to, agent });
      }
      drawEdges();
      restore(active);
    },
  };
}
