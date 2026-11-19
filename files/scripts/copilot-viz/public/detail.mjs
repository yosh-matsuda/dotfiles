// The panel with the details of one agent or one tool call. Each view builds its parts once
// and then changes only the text that changed, so that a selection or a scroll survives.

import { ACTIVE, STATUS_LABEL, TERMINAL, callRow, callSig, callState, current, fmtClock, fmtDur, fmtTokens, h, reconcile, setText } from './ui.mjs';

const RECENT_CALLS = 20;
const RETRY_MS = 5000;

function block(title, kind, tone) {
  const pre = h('pre', { class: kind === 'text' ? 'pre text' : 'pre', 'data-tone': tone });
  const el = h('section', { class: 'block', hidden: true }, h('h3', { text: title }), pre);
  return {
    el,
    set(text) {
      el.hidden = !text;
      setText(pre, text ?? '');
    },
  };
}

// Rows of a <dl>. A value is text, or a list of [class, text] spans.
function keyValues() {
  const el = h('dl', { class: 'kv' });
  let labels = null;
  const cells = new Map();
  return {
    el,
    set(rows) {
      const list = rows.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
      const sig = list.map(([k]) => k).join('\u0000');
      if (sig !== labels) {
        labels = sig;
        cells.clear();
        el.replaceChildren(...list.flatMap(([k]) => {
          const dd = h('dd');
          cells.set(k, { dd, sig: null });
          return [h('dt', { text: k }), dd];
        }));
      }
      for (const [k, v] of list) {
        const cell = cells.get(k);
        const sig = JSON.stringify(v);
        if (cell.sig === sig) continue;
        cell.sig = sig;
        if (typeof v === 'string') cell.dd.textContent = v;
        else cell.dd.replaceChildren(...v.map(([cls, text]) => h('span', { class: cls, text })));
      }
    },
  };
}

function startOf(a, s) {
  if (a.startedAt != null) return a.startedAt;
  return a.kind === 'main' ? s.meta.startedAt : null;
}

function ranFor(a, s, now) {
  const from = startOf(a, s);
  if (a.durationMs != null && !ACTIVE.has(a.display)) return fmtDur(a.durationMs);
  if (from == null) return '';
  if (ACTIVE.has(a.display) || a.display === 'idle') return a.kind === 'main' ? '' : fmtDur(now - from);
  const to = a.endedAt ?? a.lastActivityAt;
  return to == null ? '' : fmtDur(to - from);
}

function tokenText(a) {
  const t = a.tokens;
  if (t.input || t.output) {
    const parts = [`${fmtTokens(t.input)} in`, `${fmtTokens(t.output)} out`];
    if (t.cacheRead) parts.push(`${fmtTokens(t.cacheRead)} cached`);
    return parts.join(' · ');
  }
  return a.reportedTokens ? `${fmtTokens(a.reportedTokens)} total` : '';
}

function agentView(key, on) {
  const kv = keyValues();
  const task = block('Task', 'text');
  const prompt = block('Prompt', 'text');
  const message = block('Last message', 'text');
  const result = block('Result', 'text');
  const error = block('Error', 'text', 'error');
  const list = h('div', { class: 'calls-list' });
  const calls = h('section', { class: 'block', hidden: true }, h('h3', { text: 'Recent tool calls' }), list);
  const missing = h('p', { class: 'loading', hidden: true, text: 'This agent is no longer in the session.' });
  const cache = new Map();
  return {
    els: [missing, kv.el, task.el, prompt.el, message.el, result.el, error.el, calls],
    title: (s) => s.agents.find((a) => a.key === key)?.name ?? 'Agent',
    update(s, now) {
      const a = s.agents.find((x) => x.key === key);
      missing.hidden = Boolean(a);
      if (!a) {
        kv.set([]);
        for (const b of [task, prompt, message, result, error]) b.set(null);
        calls.hidden = true;
        reconcile(list, [], cache, () => null);
        return;
      }
      const main = a.kind === 'main';
      const parent = main ? null : s.agents.find((x) => x.key === a.parent);
      const m = s.meta;
      kv.set([
        ['Status', STATUS_LABEL[a.display] ?? a.display],
        ['Type', main ? 'main agent' : a.type],
        ['Model', [a.model ?? (main ? m.model : null), a.effort ?? (main ? m.effort : null)].filter(Boolean).join(' · ')],
        ['Mode', main ? (m.mode !== 'interactive' ? m.mode : null) : a.mode],
        ['Launched by', parent?.name],
        ['Started', fmtClock(startOf(a, s))],
        [TERMINAL.has(a.display) ? 'Ran for' : 'Running for', ranFor(a, s, now)],
        ['Tokens', tokenText(a)],
        ['Tool calls', a.toolCount ? String(a.toolCount) : null],
        ['Turns', a.turns ? String(a.turns) : null],
        ['Directory', main ? m.cwd : null],
        ['Repository', main ? [m.repo, m.branch].filter(Boolean).join(' · ') : null],
        ['AI credits', main && m.aic != null ? m.aic.toFixed(3) : null],
        ['Premium requests', main && m.premium != null ? String(m.premium) : null],
        ['Compactions', main && m.compactions ? String(m.compactions) : null],
        ['Copilot', main ? m.version : null],
      ]);
      task.set(main ? null : a.description);
      prompt.set(main ? m.lastPrompt : a.prompt);
      // The result of an agent often repeats its final message, and keeps more of the text.
      message.set(a.resultRepeatsMessage ? null : a.lastMessage);
      result.set(a.result);
      error.set(a.error);
      const own = s.calls.filter((c) => c.agent === key && c.name !== 'report_intent')
        .sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0)).slice(0, RECENT_CALLS);
      calls.hidden = !own.length;
      reconcile(list, own.map((c) => ({ key: c.id, sig: callSig(c, a), c })), cache, (e) => callRow(e.c, a, on.onFocusCall));
    },
  };
}

function callView(id, on, details) {
  const kv = keyValues();
  const intent = block('Intent', 'text');
  const command = block('Command', 'code');
  const output = block('Output', 'code');
  const error = block('Error', 'code', 'error');
  const loading = h('p', { class: 'loading', hidden: true });
  return {
    els: [kv.el, loading, intent.el, command.el, output.el, error.el],
    title: (s) => s.calls.find((c) => c.id === id)?.name ?? 'Tool call',
    update(s, now) {
      const c = s.calls.find((x) => x.id === id);
      if (!c) {
        kv.set([]);
        loading.hidden = false;
        setText(loading, 'This call is no longer kept. The server keeps the newest calls of each session.');
        for (const b of [intent, command, output, error]) b.set(null);
        return;
      }
      const a = s.agents.find((x) => x.key === c.agent);
      const end = c.endedAt ?? (c.status === 'running' ? now : null);
      kv.set([
        ['Tool', c.mcp ? `${c.name} (${c.mcp})` : c.name],
        ['Summary', c.summary ?? c.title],
        ['Agent', a?.name],
        ['Status', c.status === 'running' ? callState(c) : STATUS_LABEL[c.status] ?? c.status],
        ['Exit code', c.exitCode != null ? String(c.exitCode) : null],
        ['Started', fmtClock(c.startedAt)],
        [c.status === 'running' ? 'Running for' : 'Took', c.startedAt != null && end != null ? fmtDur(end - c.startedAt) : null],
        ['Changes', c.delta ? [['delta-add', `+${c.delta.add}`], ['', ' '], ['delta-del', `−${c.delta.del}`]] : null],
      ]);
      intent.set(c.intent && c.intent !== c.summary ? c.intent : null);
      error.set(c.error);
      const d = c.detail ? details(s, c) : null;
      let note = null;
      if (d?.state === 'failed') note = `The details could not be loaded. ${d.error}`;
      else if (d?.state === 'loading') note = 'Loading the details…';
      else if (d && d.data == null) note = 'The server no longer keeps the details of this call.';
      else if (c.status === 'stopped') note = 'The Copilot process ended before this call reported its end.';
      else if (c.pending && !d?.data?.preview) {
        note = s.alive === false
          ? 'The Copilot process ended before it wrote the output of this call.'
          : 'Copilot writes the output of this call when the turn ends.';
      }
      loading.hidden = note == null;
      setText(loading, note ?? '');
      command.set(d?.data?.command);
      output.set(d?.data?.preview);
    },
  };
}

export function createDetail({ panel, title, body, close, cover }, on) {
  // The text of a call changes only when its detail count does. A new epoch means the server
  // read the session again.
  const fetched = new Map();
  let key = null;
  let view = null;
  let opener = null;
  // At this width the panel lies over the activity column, so the column leaves the tab order.
  const wide = matchMedia('(min-width: 1181px)');
  const syncCover = () => {
    if (cover) cover.inert = !panel.hidden && wide.matches;
  };
  wide.addEventListener('change', syncCover);

  function details(s, c) {
    const k = `${s.id}\u0000${s.epoch}\u0000${c.id}\u0000${c.detail}`;
    let d = fetched.get(k);
    if (!d || (d.state === 'failed' && Date.now() - d.at > RETRY_MS)) {
      const next = { state: 'loading', data: null, at: 0 };
      d = next;
      fetched.set(k, next);
      if (fetched.size > 200) fetched.delete(fetched.keys().next().value);
      on.fetchCall(s.id, c.id, s.epoch).then((data) => {
        next.state = 'done';
        next.data = data;
      }, (e) => {
        next.state = 'failed';
        next.error = e.message;
        next.at = Date.now();
      }).finally(() => on.onChange());
    }
    return d;
  }

  function hide() {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    syncCover();
    key = null;
    view = null;
    body.replaceChildren();
    const back = returnTarget(opener);
    if ((inside || document.activeElement === document.body) && back) back.focus({ preventScroll: true });
    opener = null;
  }

  // An update can have replaced the element that opened the panel, or hidden it, as it hides the
  // tool row of a card whose call ended. Focus then goes to the card, or to the chosen session.
  function returnTarget(node) {
    const el = current(node);
    const card = el?.closest('.card')?.querySelector('.card-name');
    return [el, card, document.querySelector('.session[aria-current="true"]')].find((x) => x?.checkVisibility()) ?? null;
  }

  close.addEventListener('click', () => on.onClose());

  return {
    render(s, focus, now) {
      const next = s && focus ? `${s.id}\u0000${focus.type}\u0000${focus.key ?? focus.id}` : null;
      if (!next) return hide();
      if (panel.hidden) {
        const active = document.activeElement;
        opener = active instanceof HTMLElement && active !== document.body ? active : null;
        panel.hidden = false;
        syncCover();
      }
      if (next !== key) {
        key = next;
        view = focus.type === 'agent' ? agentView(focus.key, on) : callView(focus.id, on, details);
        body.replaceChildren(...view.els);
        body.scrollTop = 0;
        title.focus({ preventScroll: true });
      }
      setText(title, view.title(s));
      view.update(s, now);
      return undefined;
    },
  };
}
