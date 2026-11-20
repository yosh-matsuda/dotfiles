import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, LIMITS } from './model.mjs';
import { createStore } from './public/store.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

// E(second, type, data, agentId?)
const E = (sec, type, data = {}, agentId) => ({ type, data, timestamp: at(sec), ...(agentId ? { agentId } : {}) });
const hook = (sec, hookType, input, extra = {}) => E(sec, 'hook.start', { hookType, input, ...extra.data }, extra.agentId);
// Task results name agents by UUID.
const A = '00000000-0000-4000-8000-00000000000a';

function feed(m, sid, events) {
  for (const ev of events) m.ingest(sid, ev);
}
const view = (m, sid) => m.snapshot().sessions.find((s) => s.id === sid);
const agent = (s, key) => s.agents.find((a) => a.key === key);
const call = (s, id) => s.calls.find((c) => c.id === id);

test('a sync subagent runs under its task call and ends with the task result', () => {
  const m = createModel({ home: '/home/u' });
  feed(m, 's', [
    E(0, 'session.start', { context: { cwd: '/home/u/w' }, selectedModel: 'gpt' }),
    E(1, 'user.message', { content: 'review this' }),
    E(2, 'assistant.turn_start'),
    E(3, 'assistant.message', { content: '', toolRequests: [{ toolCallId: 'T', name: 'task', intentionSummary: 'Review' }] }),
    E(3, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'code-review', name: 'rev', mode: 'sync', prompt: 'Look' } }),
    E(4, 'subagent.started', { toolCallId: 'T', agentName: 'code-review', agentDisplayName: 'rev', agentType: 'code-review', executionMode: 'sync', resumable: false }, 'A'),
    E(4, 'user.message', { content: 'Look', source: 'agent-s' }, 'A'),
    E(5, 'assistant.turn_start', { parentToolCallId: 'T' }, 'A'),
    E(6, 'tool.execution_start', { toolCallId: 'V', toolName: 'view', arguments: { path: '/home/u/w/a.txt' }, parentToolCallId: 'T' }, 'A'),
  ]);
  let s = view(m, 's');
  assert.equal(s.state, 'running');
  assert.equal(agent(s, 'tc:T').display, 'running');
  assert.equal(agent(s, 'tc:T').current, 'V');
  assert.equal(call(s, 'V').agent, 'tc:T');
  assert.equal(call(s, 'V').summary, '~/w/a.txt');
  assert.deepEqual(agent(s, 'tc:T').phases, [
    { state: 'thinking', start: T0 + 4000, end: T0 + 6000 },
  ]);

  feed(m, 's', [
    E(7, 'tool.execution_complete', { toolCallId: 'V', success: true, result: { content: 'abc' }, parentToolCallId: 'T' }, 'A'),
    E(8, 'assistant.message', { content: 'No issues', toolRequests: [], parentToolCallId: 'T' }, 'A'),
    E(8, 'assistant.turn_end', { parentToolCallId: 'T' }, 'A'),
    E(9, 'subagent.completed', { toolCallId: 'T', totalToolCalls: 1, totalTokens: 100, durationMs: 5000 }, 'A'),
    E(9, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: 'No issues' } }),
    E(10, 'assistant.turn_start'),
    E(11, 'assistant.message', { content: 'Done', toolRequests: [] }),
    E(11, 'assistant.turn_end'),
  ]);
  s = view(m, 's');
  const a = agent(s, 'tc:T');
  assert.equal(s.agents.length, 2);
  assert.equal(a.status, 'done');
  assert.equal(a.parent, 'main');
  assert.equal(a.type, 'code-review');
  assert.equal(a.name, 'rev');
  assert.equal(a.toolCount, 1);
  assert.equal(a.result, 'No issues');
  assert.equal(agent(s, 'main').status, 'idle');
  assert.equal(s.state, 'idle');
  // The first message to the agent repeats its prompt, and its final message is its result.
  assert.deepEqual(s.feed.map((f) => f.kind), ['user', 'spawn', 'result', 'assistant']);
});

test('timeline phases distinguish idle, inferred response time, and overlapping permission waits', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'inspect this' }),
    E(2, 'assistant.turn_start'),
    E(3, 'tool.execution_start', { toolCallId: 'V', toolName: 'view' }),
    E(4, 'permission.requested', { requestId: 'p1', permissionRequest: { toolCallId: 'V' } }),
    E(4.5, 'permission.requested', { requestId: 'p2', permissionRequest: { toolCallId: 'V' } }),
    E(5, 'permission.completed', { requestId: 'p1' }),
  ]);
  let s = view(m, 's');
  assert.equal(agent(s, 'main').display, 'waiting');
  assert.deepEqual(agent(s, 'main').phases, [
    { state: 'idle', start: T0, end: T0 + 1000 },
    { state: 'thinking', start: T0 + 1000, end: T0 + 3000 },
    { state: 'waiting', start: T0 + 4000, end: null },
  ]);

  feed(m, 's', [
    E(6, 'permission.completed', { requestId: 'p2' }),
    E(7, 'tool.execution_complete', { toolCallId: 'V' }),
    E(8, 'assistant.turn_end'),
    E(9, 'user.message', { content: 'choose' }),
    E(10, 'tool.execution_start', { toolCallId: 'Q', toolName: 'ask_user' }),
    E(12, 'tool.execution_complete', { toolCallId: 'Q' }),
    E(13, 'session.task_complete'),
  ]);
  s = view(m, 's');
  assert.deepEqual(agent(s, 'main').phases, [
    { state: 'idle', start: T0, end: T0 + 1000 },
    { state: 'thinking', start: T0 + 1000, end: T0 + 3000 },
    { state: 'waiting', start: T0 + 4000, end: T0 + 6000 },
    { state: 'thinking', start: T0 + 7000, end: T0 + 8000 },
    { state: 'idle', start: T0 + 8000, end: T0 + 9000 },
    { state: 'thinking', start: T0 + 9000, end: T0 + 10_000 },
    { state: 'waiting', start: T0 + 10_000, end: T0 + 12_000 },
    { state: 'thinking', start: T0 + 12_000, end: T0 + 13_000 },
    { state: 'idle', start: T0 + 13_000, end: null },
  ]);
});

test('a background agent finishes, then write_agent starts another run', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'research' }),
    E(2, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'research', name: 'r1', mode: 'background', prompt: 'Find' } }),
    E(2, 'subagent.started', { toolCallId: 'T', agentType: 'research', agentDisplayName: 'r1', executionMode: 'background', resumable: false }, A),
    E(2, 'user.message', { content: 'Find', source: 'agent-s' }, A),
    E(3, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: `Agent started in background with agent_id: ${A}. You will be notified.` } }),
    E(4, 'assistant.message', { content: 'Waiting.', toolRequests: [] }),
    E(4, 'assistant.turn_end'),
  ]);
  let s = view(m, 's');
  assert.equal(agent(s, 'main').status, 'idle');
  assert.equal(agent(s, 'tc:T').status, 'running');
  assert.equal(agent(s, 'tc:T').mode, 'background');

  feed(m, 's', [
    E(10, 'assistant.message', { content: 'Found it', toolRequests: [], parentToolCallId: 'T' }, A),
    hook(11, 'subagentStop', { agentId: A, response: 'Found it' }),
    E(11, 'subagent.completed', { toolCallId: 'T' }, A),
    E(11, 'system.notification', { kind: { type: 'agent_idle', agentId: A, displayName: 'r1' } }),
  ]);
  s = view(m, 's');
  assert.equal(agent(s, 'tc:T').status, 'done');
  assert.equal(s.feed.filter((f) => f.agent === 'tc:T' && f.kind === 'result').length, 1);
  assert.equal(s.feed.some((f) => f.kind === 'agent'), false);

  feed(m, 's', [
    E(20, 'user.message', { content: 'follow up' }),
    E(21, 'tool.execution_start', { toolCallId: 'W', toolName: 'write_agent', arguments: { agent_id: A, message: 'More?' } }),
    E(21, 'tool.execution_complete', { toolCallId: 'W', success: true, result: { content: `Message delivered to agent ${A}.` } }),
  ]);
  s = view(m, 's');
  assert.equal(agent(s, 'tc:T').status, 'running');
  assert.equal(call(s, 'W').summary, 'r1: More?');

  feed(m, 's', [
    E(22, 'user.message', { content: 'More?', source: 'agent-s' }, A),
    hook(30, 'subagentStop', { agentId: A, response: 'Here is more' }),
  ]);
  s = view(m, 's');
  assert.equal(agent(s, 'tc:T').status, 'done');
  assert.deepEqual(s.feed.filter((f) => f.agent === 'tc:T').map((f) => f.kind), ['spawn', 'result', 'handoff', 'result']);
});

test('an agent whose end only a tool result reports leaves the inferred response time then', () => {
  const B = '00000000-0000-4000-8000-00000000000b';
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'review' }),
    E(2, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'code-review', name: 'r1', mode: 'background', prompt: 'Look' } }),
    E(2, 'subagent.started', { toolCallId: 'T', agentType: 'code-review', executionMode: 'background', resumable: true }, A),
    E(3, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: `Agent started in background with agent_id: ${A}.` } }),
    E(4, 'tool.execution_start', { toolCallId: 'R', toolName: 'read_agent', arguments: { agent_id: A, wait: true } }),
    E(5, 'assistant.message', { content: 'No issues', toolRequests: [], parentToolCallId: 'T' }, A),
    E(5, 'assistant.turn_end', { parentToolCallId: 'T' }, A),
    E(6, 'tool.execution_complete', { toolCallId: 'R', success: true, result: { content: `Agent is idle (waiting for messages). agent_id: ${A}, agent_type: code-review, status: idle, elapsed: 4s` } }),
  ]);
  let a = agent(view(m, 's'), 'tc:T');
  assert.equal(a.status, 'idle');
  assert.deepEqual(a.phases, [
    { state: 'thinking', start: T0 + 2000, end: T0 + 6000 },
    { state: 'idle', start: T0 + 6000, end: null },
  ]);

  feed(m, 's', [
    E(7, 'tool.execution_start', { toolCallId: 'W', toolName: 'write_agent', arguments: { agent_id: A, message: 'More?' } }),
    E(7, 'tool.execution_complete', { toolCallId: 'W', success: true, result: { content: `Message delivered to agent ${A}.` } }),
    // A sync agent may end with its task result alone.
    E(8, 'tool.execution_start', { toolCallId: 'S', toolName: 'task', arguments: { agent_type: 'explore', name: 'x', mode: 'sync', prompt: 'Find' } }),
    E(8, 'subagent.started', { toolCallId: 'S', agentType: 'explore', executionMode: 'sync' }, B),
    E(9, 'tool.execution_complete', { toolCallId: 'S', success: true, result: { content: 'Found' } }),
  ]);
  const s = view(m, 's');
  a = agent(s, 'tc:T');
  assert.equal(a.status, 'running');
  assert.deepEqual(a.phases.at(-1), { state: 'thinking', start: T0 + 7000, end: null });
  assert.equal(agent(s, 'tc:S').status, 'done');
  assert.deepEqual(agent(s, 'tc:S').phases, [{ state: 'thinking', start: T0 + 8000, end: T0 + 9000 }]);
});

test('an auto session shows live hooks, and its committed turns only add details', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start', { selectedModel: 'auto' }),
    E(1, 'session.fusion_resolved', { fusionId: 'f' }),
    hook(1, 'userPromptSubmitted', { prompt: 'go' }),
    E(1, 'user.message', { content: 'go' }),
    hook(2, 'preToolUse', { toolCalls: [{ id: 'B', name: 'bash', args: { command: 'ls', description: 'List' } }] }),
    hook(3, 'postToolUse', { toolName: 'bash', toolArgs: { command: 'ls' }, toolResult: { resultType: 'success' }, timestamp: T0 + 3000 }),
  ]);
  let s = view(m, 's');
  // postToolUse names the call only by toolCallId; this one lacks it, so B stays open.
  assert.equal(call(s, 'B').status, 'running');
  feed(m, 's', [
    hook(3, 'postToolUse', { toolCallId: 'B', toolName: 'bash', toolResult: { resultType: 'success' }, timestamp: T0 + 3000 }),
    hook(4, 'preToolUse', { toolCalls: [{ id: 'Q', name: 'ask_user', args: { message: 'Pick one' } }] }),
  ]);
  s = view(m, 's');
  assert.equal(call(s, 'B').status, 'ok');
  assert.equal(call(s, 'B').pending, true);
  const detail = call(s, 'B').detail;
  assert.equal(agent(s, 'main').display, 'input');
  assert.equal(s.state, 'attention');

  feed(m, 's', [E(9, 'abort', { reason: 'user_initiated' })]);
  const phasesBeforeReplay = agent(view(m, 's'), 'main').phases;
  feed(m, 's', [
    E(10, 'session.fusion_commit_started', { fusionId: 'f' }),
    E(10, 'assistant.turn_start'),
    E(10, 'assistant.message', { content: '', toolRequests: [{ toolCallId: 'B', name: 'bash', intentionSummary: 'List files' }] }),
    E(10, 'tool.execution_start', { toolCallId: 'B', toolName: 'bash', arguments: { command: 'ls', description: 'List' } }),
    E(10, 'tool.execution_complete', { toolCallId: 'B', success: true, result: { content: 'a\nb' } }),
    E(10, 'assistant.turn_end'),
    E(10, 'assistant.turn_start'),
    E(10, 'assistant.message', { content: 'Choose', toolRequests: [{ toolCallId: 'Q', name: 'ask_user' }] }),
    E(10, 'tool.execution_start', { toolCallId: 'Q', toolName: 'ask_user', arguments: { message: 'Pick one' } }),
    E(10, 'tool.execution_start', { toolCallId: 'X', toolName: 'view', arguments: { path: '/x' } }),
    E(10, 'assistant.turn_end'),
  ]);
  s = view(m, 's');
  assert.equal(s.meta.batched, true);
  assert.equal(agent(s, 'main').status, 'cancelled');
  assert.equal(call(s, 'B').startedAt, T0 + 2000);
  assert.equal(call(s, 'B').endedAt, T0 + 3000);
  assert.equal(call(s, 'B').intent, 'List files');
  assert.equal(m.callDetail('s', 'B').preview, 'a\nb');
  // The status stays ok, so only the changed detail count tells the panel to fetch the output.
  assert.notEqual(call(s, 'B').detail, detail);
  assert.equal(call(s, 'B').pending, false);
  assert.equal(call(s, 'Q').status, 'interrupted');
  assert.deepEqual(agent(s, 'main').phases, phasesBeforeReplay);

  feed(m, 's', [E(20, 'session.fusion_resolved', { fusionId: 'g' })]);
  s = view(m, 's');
  assert.equal(call(s, 'X').status, 'unknown');
  assert.equal(s.calls.filter((c) => c.status === 'running').length, 0);
  assert.deepEqual(agent(s, 'main').phases, phasesBeforeReplay);
});

test('hooks of a subagent link it to its task call before the committed turn arrives', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start', { selectedModel: 'auto' }),
    E(1, 'session.fusion_resolved'),
    hook(1, 'userPromptSubmitted', { prompt: 'go' }),
    hook(2, 'preToolUse', { toolCalls: [{ id: 'T', name: 'task', args: { agent_type: 'research', name: 'r1', mode: 'sync', prompt: 'p' } }] }),
    hook(3, 'subagentStart', { agentId: 'A', agentType: 'research', agentName: 'research', parentAgentId: 's' }),
  ]);
  let s = view(m, 's');
  // Until an event names both IDs, the hook's agent is a placeholder.
  assert.equal(s.agents.length, 3);

  feed(m, 's', [
    hook(4, 'preToolUse', { toolCalls: [{ id: 'G', name: 'grep', args: { pattern: 'x' } }] }, { agentId: 'A', data: { parentToolCallId: 'T' } }),
  ]);
  s = view(m, 's');
  assert.equal(s.agents.length, 2);
  assert.equal(agent(s, 'tc:T').display, 'running');
  assert.equal(call(s, 'G').agent, 'tc:T');

  feed(m, 's', [
    hook(5, 'postToolUse', { toolCallId: 'G', toolName: 'grep', toolResult: { resultType: 'success' } }, { agentId: 'A', data: { parentToolCallId: 'T' } }),
    hook(6, 'subagentStop', { agentId: 'A', response: 'Answer' }),
    E(6, 'subagent.completed', { toolCallId: 'T' }, 'A'),
    hook(6, 'postToolUse', { toolCallId: 'T', toolName: 'task', toolResult: { resultType: 'success' } }),
    hook(7, 'agentStop', { stopReason: 'end_turn' }),
    E(8, 'session.fusion_commit_started'),
    E(8, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'research', name: 'r1', mode: 'sync', prompt: 'p' } }),
    E(8, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: 'Answer' } }),
    E(8, 'assistant.turn_start'),
    E(8, 'session.fusion_completed'),
  ]);
  s = view(m, 's');
  assert.equal(agent(s, 'tc:T').status, 'done');
  assert.equal(agent(s, 'main').status, 'idle');
  assert.equal(call(s, 'T').endedAt, T0 + 6000);
  assert.equal(s.feed.filter((f) => f.kind === 'result').length, 1);
});

test('agents of the same type stay apart until an event links each one', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'tool.execution_start', { toolCallId: 'T1', toolName: 'task', arguments: { agent_type: 'research', name: 'one', mode: 'background' } }),
    E(1, 'tool.execution_start', { toolCallId: 'T2', toolName: 'task', arguments: { agent_type: 'research', name: 'two', mode: 'background' } }),
    hook(2, 'subagentStart', { agentId: 'A1', agentType: 'research' }),
    hook(2, 'subagentStart', { agentId: 'A2', agentType: 'research' }),
    E(3, 'assistant.message', { content: 'second speaks', toolRequests: [] }, 'A2'),
    E(4, 'subagent.started', { toolCallId: 'T2', agentType: 'research', agentDisplayName: 'two', executionMode: 'background' }, 'A2'),
    E(5, 'subagent.started', { toolCallId: 'T1', agentType: 'research', agentDisplayName: 'one', executionMode: 'background' }, 'A1'),
  ]);
  const s = view(m, 's');
  assert.equal(s.agents.length, 3);
  assert.equal(agent(s, 'tc:T1').agentId, 'A1');
  assert.equal(agent(s, 'tc:T2').agentId, 'A2');
  assert.equal(agent(s, 'tc:T2').lastMessage, 'second speaks');
  assert.equal(agent(s, 'tc:T1').lastMessage, null);
});

test('a resumed session closes the work of the previous process', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'go' }),
    E(2, 'tool.execution_start', { toolCallId: 'B', toolName: 'bash', arguments: { command: 'sleep 99' } }),
    E(2, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'x', mode: 'background' } }),
    E(3, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: `Agent started in background with agent_id: ${A}.` } }),
    E(100, 'session.resume', { context: { cwd: '/w' } }),
  ]);
  const s = view(m, 's');
  assert.equal(s.meta.generation, 2);
  assert.equal(call(s, 'B').status, 'interrupted');
  assert.equal(agent(s, 'tc:T').status, 'cancelled');
  assert.equal(agent(s, 'main').status, 'idle');
  assert.equal(s.state, 'idle');
});

test('background shells end on the notice even when it comes before the start', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'tool.execution_start', { toolCallId: 'B', toolName: 'bash', arguments: { command: 'make', description: 'Build', mode: 'async' } }),
    E(1, 'tool.execution_complete', { toolCallId: 'B', success: true, result: { content: '<command started in background with shellId: 7>' } }),
  ]);
  assert.deepEqual(view(m, 's').shells.map((x) => [x.id, x.status, x.description]), [['7', 'running', 'Build']]);
  feed(m, 's', [E(5, 'system.notification', { kind: { type: 'shell_completed', shellId: '7', exitCode: 2 } })]);
  assert.deepEqual(view(m, 's').shells.map((x) => [x.status, x.exitCode]), [['done', 2]]);

  feed(m, 's', [
    E(6, 'system.notification', { kind: { type: 'shell_completed', shellId: '8', exitCode: 0 } }),
    E(9, 'session.fusion_commit_started'),
    E(9, 'tool.execution_start', { toolCallId: 'C', toolName: 'bash', arguments: { command: 'make', mode: 'async' } }),
    E(9, 'tool.execution_complete', { toolCallId: 'C', success: true, result: { content: '<command started in background with shellId: 8>' } }),
  ]);
  assert.equal(view(m, 's').shells.find((x) => x.id === '8').status, 'done');
});

test('a rebuilt session gets a new epoch, and a restarted model uses other epochs', () => {
  const m = createModel();
  m.ingest('s', E(0, 'session.start'));
  m.ingest('t', E(0, 'session.start'));
  const first = view(m, 's').epoch;
  assert.ok(first);
  assert.notEqual(view(m, 't').epoch, first);
  m.ingest('s', E(1, 'user.message', { content: 'go' }));
  assert.equal(view(m, 's').epoch, first);
  m.resetSession('s');
  assert.notEqual(view(m, 's').epoch, first);
  const other = createModel();
  other.ingest('s', E(0, 'session.start'));
  assert.notEqual(view(other, 's').epoch, first);
});

test('a session without its process shows its open work as stopped', () => {
  const m = createModel();
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'go' }),
    E(2, 'tool.execution_start', { toolCallId: 'B', toolName: 'bash', arguments: { command: 'make', mode: 'async' } }),
    E(2, 'tool.execution_complete', { toolCallId: 'B', success: true, result: { content: '<command started in background with shellId: 7>' } }),
    E(3, 'tool.execution_start', { toolCallId: 'D', toolName: 'bash', arguments: { command: 'serve', mode: 'async', detach: true } }),
    E(3, 'tool.execution_complete', { toolCallId: 'D', success: true, result: { content: '<command started in background with shellId: 8>' } }),
    E(4, 'tool.execution_start', { toolCallId: 'V', toolName: 'view', arguments: { path: '/a' } }),
    E(5, 'permission.requested', { requestId: 'p', permissionRequest: { toolCallId: 'V' } }),
  ]);
  m.setMeta('s', { alive: true });
  let s = view(m, 's');
  assert.equal(s.state, 'attention');
  assert.equal(call(s, 'V').perm, true);
  assert.equal(agent(s, 'main').running, 1);
  assert.deepEqual(s.shells.map((x) => [x.id, x.callId, x.status]), [['7', 'B', 'running'], ['8', 'D', 'running']]);

  m.setMeta('s', { alive: false });
  s = view(m, 's');
  assert.equal(s.state, 'ended');
  assert.equal(call(s, 'V').status, 'stopped');
  assert.equal(call(s, 'V').endedAt, null);
  assert.equal(call(s, 'V').perm, false);
  assert.equal(m.callDetail('s', 'V').status, 'stopped');
  assert.equal(agent(s, 'main').running, 0);
  assert.equal(agent(s, 'main').current, 'V');
  // A detached shell can outlive the process.
  assert.deepEqual(s.shells.map((x) => [x.id, x.status]), [['7', 'stopped'], ['8', 'unknown']]);

  feed(m, 's', [E(100, 'session.resume')]);
  s = view(m, 's');
  assert.deepEqual(s.shells.map((x) => [x.id, x.status, x.endedAt]), [['7', 'stopped', T0 + 100_000], ['8', 'unknown', null]]);
});

test('an agent result that repeats its last message is flagged', () => {
  const m = createModel();
  const long = `${'word '.repeat(700)}end`;
  const run = (id, sec, message, result) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'task', arguments: { agent_type: 'x', mode: 'sync' } }),
    E(sec, 'subagent.started', { toolCallId: id, agentType: 'x' }, `A${id}`),
    E(sec + 1, 'assistant.message', { content: message, toolRequests: [], parentToolCallId: id }, `A${id}`),
    E(sec + 1, 'subagent.completed', { toolCallId: id }, `A${id}`),
    E(sec + 1, 'tool.execution_complete', { toolCallId: id, success: true, result: { content: result } }),
  ];
  feed(m, 's', [
    E(0, 'session.start'),
    ...run('L', 1, long, long),
    ...run('S', 3, 'Done.', 'Done.'),
    ...run('O', 5, long, 'Another summary'),
    ...run('E', 7, 'Wait…', 'Wait, then go'),
  ]);
  const s = view(m, 's');
  const l = agent(s, 'tc:L');
  assert.ok(l.lastMessage.length < l.result.length);
  assert.equal(l.resultRepeatsMessage, true);
  assert.equal(agent(s, 'tc:S').resultRepeatsMessage, true);
  assert.equal(agent(s, 'tc:O').resultRepeatsMessage, false);
  assert.equal(agent(s, 'tc:E').resultRepeatsMessage, false);
});

test('an agent result that starts like its last message replaces the message in the feed', () => {
  const m = createModel();
  const head = 'word '.repeat(50);
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'x', mode: 'sync' } }),
    E(1, 'subagent.started', { toolCallId: 'T', agentType: 'x' }, 'A'),
    E(2, 'assistant.message', { content: `${head}draft`, toolRequests: [], parentToolCallId: 'T' }, 'A'),
    E(2, 'subagent.completed', { toolCallId: 'T' }, 'A'),
    E(3, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: `${head}final` } }),
  ]);
  const said = view(m, 's').feed.filter((f) => f.kind === 'assistant' || f.kind === 'result');
  assert.deepEqual(said.map((f) => [f.agent, f.kind, f.text]), [['tc:T', 'result', `${head}final`]]);
});

test('an ended agent shows its end over its open question or approval', () => {
  const m = createModel();
  const run = (id, sec, open, success) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'task', arguments: { agent_type: 'x', mode: 'sync' } }),
    E(sec, 'subagent.started', { toolCallId: id, agentType: 'x' }, `A${id}`),
    ...open,
    E(sec + 2, 'tool.execution_complete', { toolCallId: id, success, result: { content: 'over' } }),
  ];
  feed(m, 's', [
    E(0, 'session.start'),
    ...run('T', 1, [
      E(2, 'tool.execution_start', { toolCallId: 'Q', toolName: 'ask_user', arguments: { message: 'Which?' }, parentToolCallId: 'T' }, 'AT'),
    ], false),
    ...run('U', 5, [
      E(6, 'tool.execution_start', { toolCallId: 'V', toolName: 'view', arguments: { path: '/a' }, parentToolCallId: 'U' }, 'AU'),
      E(6, 'permission.requested', { requestId: 'p', permissionRequest: { toolCallId: 'V' } }),
    ], true),
  ]);
  m.setMeta('s', { alive: true });
  let s = view(m, 's');
  assert.deepEqual([agent(s, 'tc:T').display, agent(s, 'tc:U').display], ['failed', 'done']);
  assert.notEqual(s.state, 'attention');
  m.setMeta('s', { alive: false });
  s = view(m, 's');
  assert.deepEqual([agent(s, 'tc:T').display, agent(s, 'tc:U').display], ['failed', 'done']);
});

test('old calls are dropped but the activity counts keep them', () => {
  const m = createModel();
  m.ingest('s', E(0, 'session.start'));
  for (let i = 0; i < LIMITS.calls + 20; i++) {
    m.ingest('s', E(i, 'tool.execution_start', { toolCallId: `c${i}`, toolName: 'view', arguments: { path: `/f${i}` } }));
    m.ingest('s', E(i, 'tool.execution_complete', { toolCallId: `c${i}`, success: true, result: { content: '' } }));
  }
  const s = view(m, 's');
  assert.equal(s.calls.length, LIMITS.calls);
  assert.equal(s.truncatedBefore, T0 + 19_000);
  assert.equal(s.activity.reduce((n, [, count]) => n + count, 0), LIMITS.calls + 20);
  assert.equal(s.meta.callCount, LIMITS.calls + 20);
});

test('a client that starts from any snapshot and applies the deltas ends with the server state', () => {
  const m = createModel();
  const events = [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'go' }),
    E(2, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'x', name: 'n', mode: 'sync' } }),
    E(3, 'subagent.started', { toolCallId: 'T', agentType: 'x' }, 'A'),
    E(4, 'tool.execution_start', { toolCallId: 'V', toolName: 'view', arguments: { path: '/a' }, parentToolCallId: 'T' }, 'A'),
    E(5, 'tool.execution_complete', { toolCallId: 'V', success: true, result: { content: 'x' }, parentToolCallId: 'T' }, 'A'),
    E(6, 'subagent.completed', { toolCallId: 'T' }, 'A'),
    E(7, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: 'ok' } }),
  ];
  const clients = [];
  for (let i = 0; i <= events.length; i++) {
    if (i > 0) {
      m.ingest(i % 2 ? 's1' : 's2', events[i - 1]);
      if (i === 4) m.removeSession('s2');
    }
    const snap = m.snapshot();
    const c = createStore();
    c.apply({ type: 'snapshot', ...snap, now: 0, ready: true });
    clients.push(c);
    const delta = m.drain();
    if (delta) for (const x of clients) x.apply({ ...delta, now: 0, ready: true });
  }
  const final = JSON.stringify(m.snapshot().sessions.sort((a, b) => a.id.localeCompare(b.id)));
  for (const c of clients) {
    assert.equal(JSON.stringify([...c.sessions.values()].sort((a, b) => a.id.localeCompare(b.id))), final);
  }
});
