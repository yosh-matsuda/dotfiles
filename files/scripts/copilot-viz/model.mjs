// Turns the events of Copilot CLI sessions into sessions, agents, tool calls, background
// shells and an activity feed. The agent lifecycle follows agenttop (see LICENSE.agenttop).
// The module is pure: the monitor feeds it events and the server drains changed sessions.

export const LIMITS = Object.freeze({ calls: 300, feed: 150, shells: 60, activityMinutes: 360 });

// Only these types are parsed; the monitor skips every other line before JSON.parse.
export const HANDLED_TYPES = new Set([
  'session.start', 'session.resume', 'session.shutdown', 'session.model_change', 'session.mode_changed',
  'session.usage_checkpoint', 'session.usage_record', 'session.compaction_start', 'session.compaction_complete',
  'session.info', 'session.warning', 'session.error', 'session.task_complete', 'session.fusion_resolved',
  'session.fusion_commit_started', 'session.fusion_completed', 'abort', 'user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end',
  'tool.execution_start', 'tool.execution_complete', 'subagent.started', 'subagent.configured',
  'subagent.completed', 'subagent.failed', 'system.notification', 'permission.requested',
  'permission.completed', 'hook.start', 'skill.invoked',
]);

const ORPHAN_MS = 120_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BACKGROUND_RE = new RegExp(`agent_id:?\\s*\`?(${UUID})`, 'i');
const AGENT_STATUS_RE = new RegExp(`agent_id: (${UUID}), agent_type: [^,]+, status: (\\w+)`, 'g');
const SHELL_STARTED_RE = /^<command (?:started in background with shellId: (\S+?)>|with shellId: (\S+) is still running)/;
const SHELL_DONE_RE = /<shellId: (\S+?) completed with exit code (-?\d+)/g;
const NOTICE_DONE_RE = new RegExp(`[Bb]ackground agent (${UUID}) (?:is |has )?(completed|complete|done|failed)`);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const REVIVABLE = new Set(['idle', 'starting', 'orphan', 'done']);
const OUTCOME_RANK = { inferred: 1, hook: 2, complete: 3 };
// In an auto (fusion) session the main agent's turns reach the log only when the turn commits,
// stamped with the commit time; hooks are written live. These replayed events add details only.
const REPLAYED = new Set(['assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'tool.execution_start', 'tool.execution_complete']);
const TEXT = { prompt: 2000, message: 1200, result: 2400, summary: 160, preview: 600, feed: 900, error: 400, command: 400 };

const CATEGORIES = {
  shell: ['bash', 'read_bash', 'write_bash', 'stop_bash', 'list_bash', 'powershell', 'read_powershell', 'write_powershell', 'stop_powershell'],
  read: ['view', 'read', 'show_file'],
  edit: ['edit', 'create', 'apply_patch', 'str_replace_editor', 'write'],
  search: ['grep', 'rg', 'glob', 'semantic_search', 'tool_search_tool', 'doSearch', 'lsp'],
  web: ['web_fetch', 'web_search', 'fetch'],
  agent: ['task', 'read_agent', 'write_agent', 'list_agents'],
  ask: ['ask_user', 'exit_plan_mode'],
  data: ['sql', 'session_store_sql', 'store_memory', 'vote_memory', 'skill', 'task_complete', 'report_intent'],
};
const CATEGORY_OF = new Map(Object.entries(CATEGORIES).flatMap(([cat, names]) => names.map((n) => [n, cat])));

export function toolCategory(name, mcp) {
  return CATEGORY_OF.get(name) ?? (mcp || /^github-mcp-server-|^mcp__/.test(name ?? '') ? 'mcp' : 'other');
}

function clip(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const oneLine = (value, max) => (typeof value === 'string' ? clip(value.replace(/\s+/g, ' '), max) : null);
function firstLine(value, max) {
  if (typeof value !== 'string') return null;
  return clip(value.split('\n').find((l) => l.trim()) ?? '', max);
}
const lineCount = (s) => (typeof s === 'string' && s.length ? s.split('\n').length : 0);
const minOf = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxOf = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
function parseTime(value) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
function resultText(data) {
  const r = data?.result;
  const c = r && typeof r === 'object' ? r.content : r;
  return typeof c === 'string' ? c : '';
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function newAgent(key, init) {
  return {
    key, kind: 'sub', parent: 'main', toolCallId: null, agentId: null, name: null, displayName: null,
    type: null, description: null, mode: null, model: null, effort: null, resumable: false,
    status: 'starting', startedAt: null, endedAt: null, lastActivityAt: null, prompt: null,
    lastMessage: null, lastMessageAt: null, result: null, error: null, tokens: { input: 0, output: 0, cacheRead: 0 },
    reportedTokens: null, toolCount: 0, reportedToolCalls: null, durationMs: null, turns: 0,
    compacting: false, placeholder: false, waiting: false, lastMsgHadTools: false, argsSeen: false,
    promptSeen: false, resultFed: false,
    ...init,
  };
}

function newSession(id, ext) {
  const S = {
    id, rev: 0, ext: { name: null, client: null, alive: null, ...ext },
    meta: {
      title: null, lastPrompt: null, cwd: null, gitRoot: null, repo: null, branch: null, model: null,
      effort: null, mode: 'interactive', version: null, startedAt: null, endedAt: null, lastEventAt: null,
      aic: null, premium: null, compactions: 0, batched: false, callCount: 0, generation: 0, errors: 0,
    },
    agents: new Map(), aliases: new Map(), calls: new Map(), shells: new Map(), shellEnds: new Map(),
    perms: new Map(), intents: new Map(), buckets: new Map(), feed: [], feedSeq: 0, truncatedBefore: null,
    replay: false,
  };
  S.agents.set('main', newAgent('main', { kind: 'main', parent: null, name: 'main', status: 'idle' }));
  return S;
}

function shortPath(path, home) {
  if (typeof path !== 'string') return null;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function touch(a, ts) {
  if (a && ts != null && (a.lastActivityAt == null || ts > a.lastActivityAt)) a.lastActivityAt = ts;
}

// New work from an agent: a turn, a tool, or a message to it.
function wake(a, ts) {
  if (!a) return;
  touch(a, ts);
  if (a.kind === 'main') {
    a.status = 'running';
    a.error = null;
  } else if (REVIVABLE.has(a.status)) {
    // Another run of a finished agent reports a new result.
    if (a.status !== 'starting') a.resultFed = false;
    a.status = 'running';
    a.endedAt = null;
  }
}

function settle(a, status, ts) {
  a.status = status;
  touch(a, ts);
  if (TERMINAL.has(status)) a.endedAt = a.endedAt ?? ts;
}

function pushFeed(S, ts, agent, kind, text) {
  if (!text) return;
  S.feed.push({ id: ++S.feedSeq, ts, agent, kind, text });
  if (S.feed.length > LIMITS.feed) S.feed.splice(0, S.feed.length - LIMITS.feed);
}

// The final message of an agent is also its result; one feed item, in the words of the result,
// shows both.
function pushResult(S, ts, a, text, ok) {
  if (a.resultFed) return;
  a.resultFed = true;
  const body = clip(text, TEXT.feed);
  if (!body) return;
  const last = S.feed.findLast((f) => f.agent === a.key);
  if (ok && last?.kind === 'assistant' && last.text.slice(0, 200) === body.slice(0, 200)) {
    last.kind = 'result';
    last.text = body;
    return;
  }
  pushFeed(S, ts, a.key, ok ? 'result' : 'error', body);
}

function agentLabel(a) {
  return a.displayName || a.name || a.type || (a.kind === 'main' ? 'main' : 'agent');
}

// --- agent identity ------------------------------------------------------------------------

// A subagent is keyed by the task call that launched it. An event that carries only the
// agent ID gets a placeholder until an event names both IDs; matching by type is not proof.
function byAgentId(S, agentId, ts, hint) {
  if (!agentId) return S.agents.get('main');
  const key = S.aliases.get(agentId);
  if (key && S.agents.has(key)) return S.agents.get(key);
  const pk = `aid:${agentId}`;
  let a = S.agents.get(pk);
  if (!a) {
    a = newAgent(pk, { agentId, placeholder: true, status: 'running', startedAt: ts, ...hint });
    S.agents.set(pk, a);
    S.aliases.set(agentId, pk);
  }
  return a;
}

function knownAgent(S, agentId) {
  const key = agentId && S.aliases.get(agentId);
  return key ? S.agents.get(key) : undefined;
}

// Events of a subagent name the task call that launched it in data.parentToolCallId.
function ownerOf(S, ev, d, ts) {
  if (typeof d.parentToolCallId === 'string' && d.parentToolCallId) {
    return ev.agentId ? link(S, ev.agentId, d.parentToolCallId, ts) : taskAgent(S, d.parentToolCallId, ts);
  }
  return byAgentId(S, ev.agentId, ts);
}

function taskAgent(S, toolCallId, ts, parent) {
  const key = `tc:${toolCallId}`;
  let a = S.agents.get(key);
  if (!a) {
    a = newAgent(key, { toolCallId, startedAt: ts, parent: parent ?? 'main' });
    S.agents.set(key, a);
  }
  return a;
}

function link(S, agentId, toolCallId, ts) {
  const t = taskAgent(S, toolCallId, ts);
  if (!agentId) return t;
  t.agentId = t.agentId ?? agentId;
  const prev = S.aliases.get(agentId);
  S.aliases.set(agentId, t.key);
  const p = prev && prev !== t.key ? S.agents.get(prev) : undefined;
  if (p) merge(S, t, p);
  return t;
}

function merge(S, t, p) {
  t.startedAt = minOf(t.startedAt, p.startedAt);
  t.lastActivityAt = maxOf(t.lastActivityAt, p.lastActivityAt);
  for (const k of ['input', 'output', 'cacheRead']) t.tokens[k] += p.tokens[k];
  t.toolCount += p.toolCount;
  t.turns += p.turns;
  for (const k of ['type', 'name', 'displayName', 'model', 'prompt', 'result', 'error', 'mode']) t[k] = t[k] ?? p[k];
  if ((p.lastMessageAt ?? -1) > (t.lastMessageAt ?? -1)) {
    t.lastMessage = p.lastMessage;
    t.lastMessageAt = p.lastMessageAt;
  }
  if (t.status === 'starting' || t.status === 'orphan') {
    t.status = p.status;
    t.endedAt = p.endedAt;
  }
  t.compacting ||= p.compacting;
  t.resultFed ||= p.resultFed;
  t.promptSeen ||= p.promptSeen;
  for (const c of S.calls.values()) if (c.agent === p.key) c.agent = t.key;
  for (const sh of S.shells.values()) if (sh.agent === p.key) sh.agent = t.key;
  for (const f of S.feed) if (f.agent === p.key) f.agent = t.key;
  for (const a of S.agents.values()) if (a.parent === p.key) a.parent = t.key;
  for (const [id, key] of S.aliases) if (key === p.key) S.aliases.set(id, t.key);
  S.agents.delete(p.key);
}

// --- tool calls ----------------------------------------------------------------------------

function summarize(S, name, args, home) {
  const a = obj(args);
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  switch (name) {
    case 'bash': case 'powershell':
      return oneLine(str(a.description) ?? firstLine(a.command, TEXT.summary), TEXT.summary);
    case 'read_bash': case 'write_bash': case 'stop_bash':
      return a.shellId != null ? `shell ${a.shellId}` : null;
    case 'view': case 'create': case 'edit': case 'str_replace_editor':
      return oneLine(shortPath(a.path, home), TEXT.summary);
    case 'apply_patch': {
      const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(str(a.input) ?? '');
      return m ? oneLine(shortPath(m[1].trim(), home), TEXT.summary) : null;
    }
    case 'grep': case 'rg': case 'glob':
      return oneLine([a.pattern, a.glob ?? (Array.isArray(a.paths) ? a.paths.join(' ') : a.paths ?? a.path)]
        .filter((v) => typeof v === 'string' && v).map((v) => shortPath(v, home)).join('  '), TEXT.summary);
    case 'web_fetch': return oneLine(a.url, TEXT.summary);
    case 'web_search': return oneLine(a.query, TEXT.summary);
    case 'task': return oneLine([a.agent_type, a.name ?? a.description].filter(Boolean).join(' · '), TEXT.summary);
    case 'read_agent': case 'write_agent': {
      const ids = Array.isArray(a.agent_ids) ? a.agent_ids : [a.agent_id];
      const names = ids.filter(Boolean).map((id) => {
        const k = knownAgent(S, id);
        return k ? agentLabel(k) : String(id).slice(0, 8);
      });
      return oneLine(names.join(', ') + (str(a.message) ? `: ${a.message}` : ''), TEXT.summary);
    }
    case 'ask_user': return firstLine(a.message, TEXT.summary);
    case 'sql': case 'session_store_sql': return oneLine(str(a.description) ?? a.query, TEXT.summary);
    case 'store_memory': case 'vote_memory': return oneLine(str(a.subject) ?? a.fact, TEXT.summary);
    case 'skill': return oneLine(a.skill, TEXT.summary);
    default: {
      for (const k of ['description', 'query', 'path', 'url', 'pattern', 'message', 'name', 'summary']) {
        if (str(a[k])) return oneLine(k === 'path' ? shortPath(a[k], home) : a[k], TEXT.summary);
      }
      const parts = Object.values(a).filter((v) => ['string', 'number'].includes(typeof v)).slice(0, 3);
      return parts.length ? oneLine(parts.join(' '), TEXT.summary) : null;
    }
  }
}

function bucket(S, ts) {
  if (ts == null) return;
  const m = Math.floor(ts / 60_000);
  S.buckets.set(m, (S.buckets.get(m) ?? 0) + 1);
}

function trimCalls(S) {
  if (S.calls.size <= LIMITS.calls) return;
  for (const [id, c] of S.calls) {
    if (S.calls.size <= LIMITS.calls) break;
    if (c.status === 'running') continue;
    S.calls.delete(id);
    S.truncatedBefore = maxOf(S.truncatedBefore, c.startedAt);
  }
}

// f.explicit: the owner comes from the committed tool event, which beats a hook's guess.
function upsertCall(S, id, owner, f, ts, home) {
  let c = S.calls.get(id);
  if (!c) {
    c = {
      id, agent: owner.key, name: f.name ?? '?', title: null, summary: null, category: 'other', mcp: null,
      startedAt: ts, endedAt: null, status: 'running', outcome: 0, exitCode: null, error: null, preview: null,
      intent: S.intents.get(id) ?? null, command: null, delta: null, perm: false, replayed: Boolean(f.replayed), extra: {},
      detailRev: 0,
    };
    S.intents.delete(id);
    S.calls.set(id, c);
    S.meta.callCount++;
    owner.toolCount++;
    bucket(S, ts);
    trimCalls(S);
  } else {
    if (ts != null && c.startedAt != null && ts < c.startedAt) c.startedAt = ts;
    if (f.explicit && c.agent !== owner.key) {
      const old = S.agents.get(c.agent);
      if (old) old.toolCount = Math.max(0, old.toolCount - 1);
      owner.toolCount++;
      c.agent = owner.key;
    }
  }
  if (f.name && c.name === '?') c.name = f.name;
  if (f.title) c.title = f.title;
  if (f.mcp) c.mcp = f.mcp;
  c.category = toolCategory(c.name, c.mcp);
  if (f.args && !c.summary) {
    const a = obj(f.args);
    c.summary = summarize(S, c.name, a, home);
    if (c.name === 'bash' || c.name === 'powershell') {
      c.command = clip(a.command, TEXT.command);
      if (c.command) c.detailRev++;
      c.extra.detach = a.detach === true;
      c.extra.description = oneLine(a.description, TEXT.summary);
    } else if (c.name === 'create') {
      c.delta = { add: lineCount(a.file_text), del: 0 };
    } else if (c.name === 'edit' || c.name === 'str_replace_editor') {
      c.delta = { add: lineCount(a.new_str), del: lineCount(a.old_str) };
    } else if (c.name === 'read_bash' || c.name === 'stop_bash') {
      c.extra.shellId = a.shellId != null ? String(a.shellId) : null;
    } else if (c.name === 'write_agent' || c.name === 'read_agent') {
      c.extra.targets = (Array.isArray(a.agent_ids) ? a.agent_ids : [a.agent_id]).filter((x) => typeof x === 'string');
    }
  }
  if (!c.summary && c.intent) c.summary = c.intent;
  return c;
}

// Outcomes rank: an explicit completion beats a hook, which beats an inferred closure.
// The end time keeps the earliest evidence, because committed events can arrive late.
function endCall(c, ts, o) {
  if (ts != null) c.endedAt = Math.max(c.startedAt ?? ts, minOf(c.endedAt, ts));
  const rank = OUTCOME_RANK[o.source];
  if (rank >= c.outcome) {
    c.status = o.status;
    c.outcome = rank;
  }
  if (o.exitCode != null) c.exitCode = o.exitCode;
  if (o.error) c.error = oneLine(o.error, TEXT.error);
  if (o.preview) {
    c.preview = clip(o.preview, TEXT.preview);
    c.detailRev++;
  }
  c.perm = false;
}

function closeDangling(S, agentKey, ts, status) {
  for (const c of S.calls.values()) {
    if (c.agent === agentKey && c.status === 'running') endCall(c, ts, { source: 'inferred', status });
  }
}

// A replayed call without its completion was never finished.
function endReplay(S, ts) {
  if (!S.replay) return;
  S.replay = false;
  for (const c of S.calls.values()) {
    if (c.replayed && c.status === 'running') endCall(c, ts, { source: 'inferred', status: 'unknown' });
  }
}

function resetInflight(S, ts, mainStatus) {
  S.replay = false;
  S.shellEnds.clear();
  for (const c of S.calls.values()) if (c.status === 'running') endCall(c, ts, { source: 'inferred', status: 'interrupted' });
  for (const a of S.agents.values()) {
    a.compacting = false;
    a.waiting = false;
    if (a.kind === 'main') settle(a, mainStatus, ts);
    else if (a.status === 'idle') settle(a, 'done', ts);
    else if (!TERMINAL.has(a.status)) settle(a, 'cancelled', ts);
  }
  // A detached shell can outlive the process, which then never reports its end.
  for (const sh of S.shells.values()) {
    if (sh.status !== 'running') continue;
    sh.status = sh.detached ? 'unknown' : 'stopped';
    if (!sh.detached) sh.endedAt = ts;
  }
  S.perms.clear();
}

function onTaskStart(S, c, args, owner, ts) {
  const a = taskAgent(S, c.id, ts, owner.key);
  if (a.argsSeen) return;
  const x = obj(args);
  a.argsSeen = true;
  a.parent = owner.key;
  a.name = a.name ?? oneLine(x.name, 80);
  a.type = a.type ?? oneLine(x.agent_type, 60);
  a.description = a.description ?? oneLine(x.description, 200);
  a.mode = a.mode ?? (x.mode === 'background' ? 'background' : 'sync');
  a.model = a.model ?? oneLine(x.model, 60);
  a.prompt = a.prompt ?? clip(x.prompt, TEXT.prompt);
  a.startedAt = minOf(a.startedAt, ts);
  pushFeed(S, ts, a.key, 'spawn', oneLine(`${a.type ?? 'agent'} agent ${a.name ?? a.description ?? ''}`, TEXT.summary));
}

function shellFor(S, id, c, ts) {
  let sh = S.shells.get(id);
  if (!sh) {
    sh = {
      id, agent: c?.agent ?? 'main', callId: c?.id ?? null, description: c?.extra.description ?? null,
      command: c ? firstLine(c.command, TEXT.summary) : null, detached: Boolean(c?.extra.detach),
      status: 'running', exitCode: null, startedAt: c?.startedAt ?? ts, endedAt: null,
    };
    // A replayed start can follow the live notice that the shell finished.
    const end = S.shellEnds.get(id);
    if (end) Object.assign(sh, end);
    S.shells.set(id, sh);
    for (const [k, v] of S.shells) {
      if (S.shells.size <= LIMITS.shells) break;
      if (v.status !== 'running') S.shells.delete(k);
    }
  }
  return sh;
}

function endShell(S, id, ts, status, exitCode) {
  const sh = S.shells.get(id);
  if (!sh) {
    S.shellEnds.set(id, { status, exitCode: exitCode ?? null, endedAt: ts });
    if (S.shellEnds.size > 200) S.shellEnds.delete(S.shellEnds.keys().next().value);
    return;
  }
  if (sh.status !== 'running') return;
  sh.status = status;
  sh.exitCode = exitCode ?? sh.exitCode;
  sh.endedAt = ts;
}

function agentStatusFromText(a, status, ts) {
  if (!a) return;
  if (status === 'running') wake(a, ts);
  else if (status === 'idle') {
    if (!TERMINAL.has(a.status)) settle(a, 'idle', ts);
  } else if (status === 'completed' || status === 'done') settle(a, 'done', ts);
  else if (status === 'failed') settle(a, 'failed', ts);
  else if (status === 'cancelled') settle(a, 'cancelled', ts);
}

// live is false for replayed events, which may only fill in what no live event reported.
function afterComplete(S, c, text, success, ts, live) {
  switch (c.name) {
    case 'task': {
      const a = taskAgent(S, c.id, ts, c.agent);
      const unseen = a.status === 'starting' || a.status === 'orphan';
      const head = text.slice(0, 400);
      const bg = success ? BACKGROUND_RE.exec(head) : null;
      if (bg && /background/i.test(head)) {
        link(S, bg[1], c.id, ts);
        a.mode = 'background';
        if (unseen) settle(a, 'running', ts);
        if (/moved to background/i.test(head)) pushFeed(S, ts, a.key, 'agent', 'moved to the background');
      } else {
        if (live ? !TERMINAL.has(a.status) : unseen) settle(a, success ? 'done' : 'failed', ts);
        if (!success) a.error = a.error ?? oneLine(c.error ?? text, TEXT.error);
        a.result = (live ? clip(text, TEXT.result) : null) ?? a.result ?? clip(text, TEXT.result);
        pushResult(S, ts, a, text, success);
      }
      break;
    }
    case 'write_agent':
      if (success && live) for (const id of c.extra.targets ?? []) wake(knownAgent(S, id), ts);
      break;
    case 'read_agent': case 'list_agents':
      if (live) for (const m of text.matchAll(AGENT_STATUS_RE)) agentStatusFromText(knownAgent(S, m[1]), m[2], ts);
      break;
    case 'bash': case 'powershell': {
      const m = SHELL_STARTED_RE.exec(text);
      if (m) shellFor(S, m[1] ?? m[2], c, ts);
      for (const d of text.matchAll(SHELL_DONE_RE)) endShell(S, d[1], ts, 'done', Number(d[2]));
      break;
    }
    case 'read_bash': {
      for (const d of text.matchAll(SHELL_DONE_RE)) endShell(S, d[1], ts, 'done', Number(d[2]));
      // A large output is replaced by a file reference that drops the marker.
      if (c.extra.shellId && !/is still running/.test(text)) endShell(S, c.extra.shellId, ts, 'done', null);
      break;
    }
    case 'stop_bash':
      if (c.extra.shellId) endShell(S, c.extra.shellId, ts, 'stopped', null);
      break;
    default:
  }
}

// --- event handlers ------------------------------------------------------------------------

function onStart(S, d, ts, resume) {
  S.meta.generation++;
  // Work from an earlier process of a resumed session never reports its end.
  if (S.meta.generation > 1 || resume) resetInflight(S, ts, 'idle');
  const ctx = obj(d.context);
  const m = S.meta;
  m.cwd = ctx.cwd ?? m.cwd;
  m.gitRoot = ctx.gitRoot ?? m.gitRoot;
  m.repo = ctx.repository ?? m.repo;
  m.branch = ctx.branch ?? m.branch;
  m.model = d.selectedModel ?? m.model;
  m.effort = d.reasoningEffort ?? m.effort;
  m.version = d.copilotVersion ?? m.version;
  m.startedAt = m.startedAt ?? parseTime(d.startTime) ?? ts;
  m.endedAt = null;
  settle(S.agents.get('main'), 'idle', ts);
  if (resume) pushFeed(S, ts, 'main', 'notice', 'Session resumed');
}

function onHook(S, ev, ts, home) {
  const d = obj(ev.data);
  const input = obj(d.input);
  switch (d.hookType) {
    case 'preToolUse': {
      const owner = ownerOf(S, ev, d, ts);
      for (const tc of Array.isArray(input.toolCalls) ? input.toolCalls : []) {
        if (!tc?.id) continue;
        const c = upsertCall(S, tc.id, owner, { name: tc.name, args: tc.args }, ts, home);
        if (c.status !== 'running') continue;
        wake(owner, ts);
        if (c.name === 'task') onTaskStart(S, c, tc.args, owner, ts);
      }
      break;
    }
    case 'postToolUse': case 'postToolUseFailure': {
      if (!input.toolCallId) break;
      const owner = ownerOf(S, ev, d, ts);
      const c = upsertCall(S, input.toolCallId, owner, { name: input.toolName, args: input.toolArgs }, ts, home);
      const type = obj(input.toolResult).resultType;
      const failed = d.hookType === 'postToolUseFailure' || (type != null && type !== 'success');
      const err = input.error;
      endCall(c, parseTime(input.timestamp) ?? ts, {
        source: 'hook', status: failed ? 'failed' : 'ok', error: typeof err === 'string' ? err : obj(err).message,
      });
      touch(owner, ts);
      const task = c.name === 'task' && failed ? S.agents.get(`tc:${c.id}`) : undefined;
      if (task && (task.status === 'starting' || task.status === 'orphan')) {
        settle(task, 'failed', ts);
        task.error = task.error ?? c.error;
      }
      break;
    }
    case 'preMcpToolCall': {
      const c = input.toolCallId && S.calls.get(input.toolCallId);
      if (c && input.serverName) {
        c.mcp = String(input.serverName);
        c.category = 'mcp';
      }
      break;
    }
    case 'subagentStart': {
      if (!input.agentId) break;
      const known = knownAgent(S, input.agentId);
      if (known) {
        wake(known, ts);
        break;
      }
      byAgentId(S, input.agentId, ts, {
        parent: knownAgent(S, input.parentAgentId)?.key ?? 'main',
        type: oneLine(input.agentType, 60),
        name: oneLine(input.agentName, 80),
      });
      break;
    }
    case 'subagentStop': {
      if (!input.agentId) break;
      const a = byAgentId(S, input.agentId, ts);
      const response = clip(input.response, TEXT.result);
      if (response) {
        a.result = response;
        a.lastMessage = clip(input.response, TEXT.message);
        a.lastMessageAt = ts;
        pushResult(S, ts, a, input.response, true);
      }
      // A sync agent ends with the task result; a background one ends here.
      if (a.mode !== 'sync' && a.status === 'running') settle(a, a.resumable ? 'idle' : 'done', ts);
      touch(a, ts);
      break;
    }
    case 'agentStop':
      if (!ev.agentId) {
        const main = S.agents.get('main');
        if (main.status === 'running') settle(main, 'idle', ts);
        closeDangling(S, 'main', ts, 'unknown');
      }
      break;
    case 'userPromptSubmitted':
      if (!ev.agentId) {
        endReplay(S, ts);
        wake(S.agents.get('main'), ts);
      }
      break;
    case 'errorOccurred': {
      const e = input.error;
      pushFeed(S, ts, ownerOf(S, ev, d, ts).key, 'error', oneLine(typeof e === 'string' ? e : obj(e).message, TEXT.error));
      break;
    }
    default:
  }
}

function handle(S, ev, home) {
  const d = obj(ev.data);
  const ts = parseTime(ev.timestamp) ?? S.meta.lastEventAt;
  if (ts != null) S.meta.lastEventAt = maxOf(S.meta.lastEventAt, ts);
  const main = S.agents.get('main');
  const live = !(S.replay && !ev.agentId && REPLAYED.has(ev.type));
  switch (ev.type) {
    case 'session.start': onStart(S, d, ts, false); break;
    case 'session.resume': onStart(S, d, ts, true); break;
    case 'session.shutdown': {
      const nano = obj(d.accountingSnapshot).totalNanoAiu;
      if (typeof nano === 'number') S.meta.aic = nano / 1e9;
      resetInflight(S, ts, 'done');
      S.meta.endedAt = ts;
      pushFeed(S, ts, 'main', 'notice', 'Session ended');
      break;
    }
    case 'session.model_change': {
      const a = byAgentId(S, ev.agentId, ts);
      a.model = d.newModel ?? a.model;
      a.effort = d.reasoningEffort ?? a.effort;
      if (!ev.agentId) {
        S.meta.model = d.newModel ?? S.meta.model;
        S.meta.effort = d.reasoningEffort ?? S.meta.effort;
      }
      break;
    }
    case 'session.mode_changed': S.meta.mode = d.newMode ?? S.meta.mode; break;
    case 'session.usage_checkpoint':
      if (typeof d.totalNanoAiu === 'number') S.meta.aic = d.totalNanoAiu / 1e9;
      if (typeof d.totalPremiumRequests === 'number') S.meta.premium = d.totalPremiumRequests;
      break;
    case 'session.usage_record': {
      const u = obj(d.usage ?? d);
      const a = byAgentId(S, ev.agentId, ts);
      a.tokens.input += Number(u.inputTokens) || 0;
      a.tokens.output += Number(u.outputTokens) || 0;
      a.tokens.cacheRead += Number(u.cacheReadTokens) || 0;
      if (u.model) a.model = a.kind === 'main' ? String(u.model) : a.model ?? String(u.model);
      touch(a, ts);
      break;
    }
    case 'session.compaction_start': byAgentId(S, ev.agentId, ts).compacting = true; break;
    case 'session.compaction_complete': {
      byAgentId(S, ev.agentId, ts).compacting = false;
      if (!ev.agentId) {
        S.meta.compactions++;
        pushFeed(S, ts, 'main', 'notice', d.success === false ? 'Context compaction failed' : 'Context compacted');
      }
      break;
    }
    case 'session.info': case 'session.warning':
      // An info of type notification repeats the terminal notification of an ask_user call.
      if (d.infoType !== 'notification') pushFeed(S, ts, 'main', 'notice', oneLine(d.message, TEXT.feed));
      break;
    case 'session.error':
      S.meta.errors++;
      if (main.status === 'running') settle(main, 'failed', ts);
      main.error = oneLine(d.message, TEXT.error);
      pushFeed(S, ts, 'main', 'error', oneLine(d.message, TEXT.feed));
      break;
    case 'session.task_complete': settle(main, d.success === false ? 'failed' : 'idle', ts); break;
    case 'session.fusion_resolved':
      S.meta.batched = true;
      endReplay(S, ts);
      break;
    case 'session.fusion_commit_started':
      S.meta.batched = true;
      S.replay = true;
      break;
    case 'session.fusion_completed': endReplay(S, ts); break;
    case 'abort':
      settle(main, 'cancelled', ts);
      closeDangling(S, 'main', ts, 'interrupted');
      for (const a of S.agents.values()) {
        if (a.kind === 'sub' && a.mode === 'sync' && (a.status === 'running' || a.status === 'starting')) settle(a, 'cancelled', ts);
      }
      pushFeed(S, ts, 'main', 'notice', oneLine(`Aborted${d.reason ? `: ${d.reason}` : ''}`, TEXT.feed));
      break;
    case 'user.message': {
      const text = typeof d.content === 'string' ? d.content : '';
      if (ev.agentId) {
        const a = byAgentId(S, ev.agentId, ts);
        // The first message to an agent repeats the prompt of its task call.
        const repeat = !a.promptSeen && a.argsSeen;
        a.promptSeen = true;
        a.prompt = a.prompt ?? clip(text, TEXT.prompt);
        wake(a, ts);
        if (!repeat) pushFeed(S, ts, a.key, 'handoff', clip(text, TEXT.feed));
      } else {
        endReplay(S, ts);
        S.meta.title = S.meta.title ?? oneLine(text, 200);
        S.meta.lastPrompt = clip(text, TEXT.prompt);
        wake(main, ts);
        pushFeed(S, ts, 'main', 'user', clip(text, TEXT.feed));
      }
      break;
    }
    case 'assistant.turn_start': {
      const a = ownerOf(S, ev, d, ts);
      a.turns++;
      if (live) wake(a, ts);
      break;
    }
    case 'assistant.message': {
      const a = ownerOf(S, ev, d, ts);
      const requests = Array.isArray(d.toolRequests) ? d.toolRequests : [];
      a.lastMsgHadTools = requests.length > 0;
      for (const r of requests) {
        if (!r?.toolCallId || !r.intentionSummary) continue;
        const intent = oneLine(r.intentionSummary, TEXT.summary);
        const c = S.calls.get(r.toolCallId);
        if (c) {
          c.intent = c.intent ?? intent;
          c.summary = c.summary ?? intent;
        } else {
          S.intents.set(r.toolCallId, intent);
          if (S.intents.size > 500) S.intents.delete(S.intents.keys().next().value);
        }
      }
      const content = clip(d.content, TEXT.message);
      if (content) {
        a.lastMessage = content;
        a.lastMessageAt = ts;
        pushFeed(S, ts, a.key, 'assistant', clip(d.content, TEXT.feed));
      }
      if (d.model && a.kind === 'sub') a.model = a.model ?? String(d.model);
      touch(a, ts);
      break;
    }
    case 'assistant.turn_end': {
      const a = ownerOf(S, ev, d, ts);
      touch(a, ts);
      // A turn that requested tools is followed by another turn within a fraction of a second.
      if (live && a.kind === 'main' && !a.lastMsgHadTools && a.status === 'running') {
        settle(a, 'idle', ts);
        closeDangling(S, 'main', ts, 'unknown');
      }
      break;
    }
    case 'tool.execution_start': {
      if (!d.toolCallId) break;
      const owner = ownerOf(S, ev, d, ts);
      const c = upsertCall(S, d.toolCallId, owner, {
        name: d.toolName, args: d.arguments, title: d.toolTitle, mcp: d.mcpServerName, explicit: true, replayed: !live,
      }, ts, home);
      if (c.status === 'running') {
        if (live) wake(owner, ts);
        if (c.name === 'task') onTaskStart(S, c, d.arguments, owner, ts);
      }
      break;
    }
    case 'tool.execution_complete': {
      if (!d.toolCallId) break;
      const c = upsertCall(S, d.toolCallId, ownerOf(S, ev, d, ts), { replayed: !live }, ts, home);
      const text = resultText(d);
      const success = d.success !== false;
      const err = obj(d.error).message ?? (typeof d.error === 'string' ? d.error : null);
      endCall(c, ts, {
        source: 'complete', status: success ? 'ok' : 'failed', exitCode: obj(d.shellExecution).exitCode,
        error: success ? null : err ?? text, preview: text,
      });
      touch(S.agents.get(c.agent), ts);
      afterComplete(S, c, text, success, ts, live);
      break;
    }
    case 'subagent.started': {
      const a = d.toolCallId ? link(S, ev.agentId, d.toolCallId, ts) : byAgentId(S, ev.agentId, ts);
      a.displayName = oneLine(d.agentDisplayName, 80) ?? a.displayName;
      a.type = oneLine(d.agentType ?? d.agentName, 60) ?? a.type;
      a.description = a.description ?? oneLine(d.agentDescription, 200);
      a.model = d.model ?? a.model;
      a.mode = d.executionMode ?? a.mode;
      a.resumable = Boolean(d.resumable);
      a.placeholder = false;
      wake(a, ts);
      break;
    }
    case 'subagent.configured': {
      const a = d.toolCallId ? link(S, ev.agentId, d.toolCallId, ts) : byAgentId(S, ev.agentId, ts);
      a.model = d.model ?? a.model;
      a.effort = d.reasoningEffort ?? a.effort;
      break;
    }
    case 'subagent.completed': {
      const a = d.toolCallId ? link(S, ev.agentId, d.toolCallId, ts) : byAgentId(S, ev.agentId, ts);
      a.reportedToolCalls = d.totalToolCalls ?? a.reportedToolCalls;
      a.reportedTokens = d.totalTokens ?? a.reportedTokens;
      a.durationMs = d.durationMs ?? a.durationMs;
      a.model = d.model ?? a.model;
      if (d.cancelled) settle(a, 'cancelled', ts);
      else if (a.mode === 'background' && a.resumable) settle(a, 'idle', ts);
      else settle(a, 'done', ts);
      break;
    }
    case 'subagent.failed': {
      const a = d.toolCallId ? link(S, ev.agentId, d.toolCallId, ts) : byAgentId(S, ev.agentId, ts);
      settle(a, 'failed', ts);
      a.error = oneLine(typeof d.error === 'string' ? d.error : obj(d.error).message, TEXT.error) ?? a.error;
      pushFeed(S, ts, a.key, 'error', a.error ?? 'Agent failed');
      break;
    }
    case 'system.notification': {
      const k = obj(d.kind);
      if (k.type === 'agent_idle' || k.type === 'agent_completed') {
        const a = knownAgent(S, k.agentId);
        let next = null;
        if (a && k.type === 'agent_completed') next = k.status === 'failed' ? 'failed' : 'done';
        // Only a resumable agent keeps waiting for messages; write_agent can still wake a done one.
        else if (a && !TERMINAL.has(a.status)) next = a.resumable ? 'idle' : 'done';
        if (next) settle(a, next, ts);
        const who = k.displayName ?? (a ? agentLabel(a) : 'agent');
        if (!a?.resultFed) pushFeed(S, ts, a?.key ?? 'main', 'agent', oneLine(`${who} finished`, TEXT.feed));
      } else if (k.type === 'shell_completed' || k.type === 'shell_detached_completed') {
        const id = String(k.shellId);
        endShell(S, id, ts, 'done', typeof k.exitCode === 'number' ? k.exitCode : null);
        const label = k.description ? `"${k.description}"` : id;
        const code = typeof k.exitCode === 'number' ? ` (exit ${k.exitCode})` : '';
        pushFeed(S, ts, S.shells.get(id)?.agent ?? 'main', 'notice', oneLine(`Shell ${label} finished${code}`, TEXT.feed));
      } else {
        const m = NOTICE_DONE_RE.exec(typeof d.content === 'string' ? d.content : '');
        const a = m && knownAgent(S, m[1]);
        if (a) settle(a, m[2] === 'failed' ? 'failed' : 'done', ts);
      }
      break;
    }
    case 'permission.requested': {
      const req = obj(d.permissionRequest);
      const c = req.toolCallId ? S.calls.get(req.toolCallId) : undefined;
      if (c) c.perm = true;
      const a = c ? S.agents.get(c.agent) : byAgentId(S, ev.agentId, ts);
      if (!c && a) a.waiting = true;
      if (d.requestId) S.perms.set(d.requestId, { call: c?.id ?? null, agent: a?.key ?? null });
      break;
    }
    case 'permission.completed': {
      const p = d.requestId ? S.perms.get(d.requestId) : undefined;
      if (!p) break;
      const c = p.call ? S.calls.get(p.call) : undefined;
      if (c) c.perm = false;
      const a = p.agent ? S.agents.get(p.agent) : undefined;
      if (a) a.waiting = false;
      S.perms.delete(d.requestId);
      break;
    }
    case 'skill.invoked': {
      const name = d.name ?? d.skillName ?? d.skill ?? '?';
      pushFeed(S, ts, byAgentId(S, ev.agentId, ts).key, 'notice', oneLine(`Skill: ${name}`, TEXT.feed));
      break;
    }
    case 'hook.start': onHook(S, ev, ts, home); break;
    default:
  }
}

// --- serialization -------------------------------------------------------------------------

// A message clipped at TEXT.message that starts the result says the same; the result keeps more.
function repeats(message, result) {
  if (!message || !result) return false;
  if (message === result) return true;
  return message.length === TEXT.message && message.endsWith('…') && result.startsWith(message.slice(0, -1));
}

// A session without its process never reports the end of its open work.
const shownStatus = (S, c) => (S.ext.alive === false && c.status === 'running' ? 'stopped' : c.status);

function serialize(S) {
  const running = new Map();
  for (const c of S.calls.values()) {
    if (c.status !== 'running') continue;
    const list = running.get(c.agent) ?? [];
    list.push(c);
    running.set(c.agent, list);
  }
  const alive = S.ext.alive;
  const agents = [...S.agents.values()].map((a) => {
    const rc = running.get(a.key) ?? [];
    let display = a.status;
    // An agent that ended keeps its end, even when a question or an approval of it stays open.
    if (!TERMINAL.has(display)) {
      if (rc.some((c) => c.category === 'ask')) display = 'input';
      else if (a.waiting || rc.some((c) => c.perm)) display = 'waiting';
      if (alive === false) display = 'stopped';
    }
    const current = rc.reduce((best, c) => (!best || (c.startedAt ?? 0) >= (best.startedAt ?? 0) ? c : best), null);
    return {
      key: a.key, parent: a.parent, kind: a.kind, agentId: a.agentId, name: agentLabel(a), type: a.type,
      description: a.description, mode: a.mode, model: a.model, effort: a.effort, status: a.status, display,
      startedAt: a.startedAt, endedAt: a.endedAt, lastActivityAt: a.lastActivityAt, prompt: a.prompt,
      lastMessage: a.lastMessage, lastMessageAt: a.lastMessageAt, result: a.result, error: a.error,
      tokens: { ...a.tokens }, reportedTokens: a.reportedTokens, toolCount: Math.max(a.toolCount, a.reportedToolCalls ?? 0),
      durationMs: a.durationMs, turns: a.turns, compacting: a.compacting, placeholder: a.placeholder,
      current: current?.id ?? null, running: alive === false ? 0 : rc.length,
      resultRepeatsMessage: repeats(a.lastMessage, a.result),
    };
  });
  const displays = new Set(agents.map((a) => a.display));
  let state = 'idle';
  if (displays.has('input') || displays.has('waiting')) state = 'attention';
  else if (displays.has('running') || displays.has('starting')) state = 'running';
  else if (alive === false || S.meta.endedAt != null) state = 'ended';
  // Previews and commands are large; the detail panel asks for them with callDetail.
  // detail counts the changes of that text, so the panel knows when to ask again.
  // pending: a hook ended the call, and its output comes when Copilot commits the turn.
  const calls = [...S.calls.values()].map((c) => ({
    id: c.id, agent: c.agent, name: c.name, title: c.title, summary: c.summary, category: c.category, mcp: c.mcp,
    startedAt: c.startedAt, endedAt: c.endedAt, status: shownStatus(S, c), exitCode: c.exitCode, error: c.error,
    intent: c.intent, delta: c.delta, perm: c.perm && alive !== false, detail: c.detailRev,
    pending: S.meta.batched && c.outcome === OUTCOME_RANK.hook,
  }));
  const shells = [...S.shells.values()].map((sh) => ({
    ...sh, status: alive === false && sh.status === 'running' ? (sh.detached ? 'unknown' : 'stopped') : sh.status,
  }));
  let newest = 0;
  for (const m of S.buckets.keys()) newest = Math.max(newest, m);
  for (const m of S.buckets.keys()) if (m <= newest - LIMITS.activityMinutes) S.buckets.delete(m);
  const activity = [...S.buckets].sort((x, y) => x[0] - y[0]);
  return {
    id: S.id, epoch: S.epoch, rev: S.rev, state, name: S.ext.name, client: S.ext.client, alive,
    meta: { ...S.meta }, agents, calls, feed: S.feed.map((f) => ({ ...f })), shells,
    activity, truncatedBefore: S.truncatedBefore,
  };
}

// --- public API ----------------------------------------------------------------------------

export function createModel({ home = '', now = Date.now, onError = null } = {}) {
  const sessions = new Map();
  const dirty = new Set();
  const removed = new Set();
  let rev = 0;
  let errors = 0;
  // A client keeps the state of a session, such as its feed scroll, while the epoch stays.
  // The base keeps the epochs of a restarted server apart from the epochs before.
  const base = Math.random().toString(36).slice(2, 8);
  let epochs = 0;
  const fresh = (sid, ext) => {
    const S = newSession(sid, ext);
    S.epoch = `${base}.${++epochs}`;
    return S;
  };

  const session = (sid) => {
    let S = sessions.get(sid);
    if (!S) {
      S = fresh(sid);
      sessions.set(sid, S);
      removed.delete(sid);
    }
    return S;
  };

  return {
    ingest(sid, ev) {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      const S = session(sid);
      try {
        handle(S, ev, home);
      } catch (err) {
        errors++;
        onError?.(err, sid, ev.type);
      }
      dirty.add(sid);
    },
    setMeta(sid, patch) {
      const S = session(sid);
      for (const [k, v] of Object.entries(patch)) {
        if (S.ext[k] === v) continue;
        S.ext[k] = v;
        dirty.add(sid);
      }
    },
    // Rebuilds a session from scratch, such as after its log was replaced.
    resetSession(sid) {
      sessions.set(sid, fresh(sid, sessions.get(sid)?.ext));
      removed.delete(sid);
      dirty.add(sid);
    },
    removeSession(sid) {
      if (!sessions.delete(sid)) return;
      dirty.delete(sid);
      removed.add(sid);
    },
    has: (sid) => sessions.has(sid),
    callDetail(sid, id, epoch) {
      const S = sessions.get(sid);
      if (epoch !== undefined && epoch !== S?.epoch) {
        throw Object.assign(new Error('This session was reloaded; select the call again.'), { status: 409 });
      }
      const c = S?.calls.get(id);
      if (!c) return null;
      return {
        id: c.id, name: c.name, title: c.title, summary: c.summary, intent: c.intent, status: shownStatus(S, c),
        exitCode: c.exitCode, error: c.error, preview: c.preview, command: c.command, delta: c.delta,
        startedAt: c.startedAt, endedAt: c.endedAt, mcp: c.mcp,
      };
    },
    tick() {
      const t = now();
      for (const S of sessions.values()) {
        for (const a of S.agents.values()) {
          if (a.status === 'starting' && !a.agentId && a.startedAt != null && t - a.startedAt > ORPHAN_MS) {
            a.status = 'orphan';
            dirty.add(S.id);
          }
        }
      }
    },
    snapshot: () => ({ rev, sessions: [...sessions.values()].map(serialize) }),
    drain() {
      if (!dirty.size && !removed.size) return null;
      rev++;
      const out = { rev, sessions: [], removed: [...removed] };
      for (const sid of dirty) {
        const S = sessions.get(sid);
        if (!S) continue;
        S.rev = rev;
        out.sessions.push(serialize(S));
      }
      dirty.clear();
      removed.clear();
      return out;
    },
    stats: () => ({ sessions: sessions.size, errors }),
  };
}
