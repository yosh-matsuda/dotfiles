import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel, HANDLED_TYPES, LIMITS } from './model.mjs';
import { createStore, isDormant } from './public/store.mjs';
import { lanesOf } from './public/timeline.mjs';

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

test('an idle subagent sleeps an hour after it went idle, even when a read of it comes later', () => {
  const m = createModel();
  const min = (n) => n * 60;
  feed(m, 's', [
    E(0, 'session.start'),
    E(1, 'user.message', { content: 'review' }),
    E(2, 'tool.execution_start', { toolCallId: 'T', toolName: 'task', arguments: { agent_type: 'code-review', name: 'r1', mode: 'background', prompt: 'Look' } }),
    E(2, 'subagent.started', { toolCallId: 'T', agentType: 'code-review', executionMode: 'background', resumable: true }, A),
    E(3, 'tool.execution_complete', { toolCallId: 'T', success: true, result: { content: `Agent started in background with agent_id: ${A}.` } }),
    E(5, 'assistant.turn_end', { parentToolCallId: 'T' }, A),
    E(6, 'tool.execution_start', { toolCallId: 'R1', toolName: 'read_agent', arguments: { agent_id: A } }),
    E(6, 'tool.execution_complete', { toolCallId: 'R1', success: true, result: { content: `agent_id: ${A}, agent_type: code-review, status: idle, elapsed: 4s` } }),
    E(min(50), 'tool.execution_start', { toolCallId: 'R2', toolName: 'read_agent', arguments: { agent_id: A } }),
    E(min(50), 'tool.execution_complete', { toolCallId: 'R2', success: true, result: { content: `agent_id: ${A}, agent_type: code-review, status: idle, elapsed: 50m` } }),
  ]);
  const a = () => agent(view(m, 's'), 'tc:T');
  assert.equal(a().display, 'idle');
  assert.equal(isDormant(a(), T0 + min(59) * 1000), false);
  assert.equal(isDormant(a(), T0 + min(61) * 1000), true);
  feed(m, 's', [
    E(min(62), 'tool.execution_start', { toolCallId: 'W', toolName: 'write_agent', arguments: { agent_id: A, message: 'More?' } }),
    E(min(62), 'tool.execution_complete', { toolCallId: 'W', success: true, result: { content: `Message delivered to agent ${A}.` } }),
  ]);
  assert.equal(isDormant(a(), T0 + min(63) * 1000), false);
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

test('a shellId given again starts a new shell that an older end does not end', () => {
  const m = createModel();
  const start = (sec, id, command, shellId) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'bash', arguments: { command, mode: 'async', shellId } }),
    E(sec, 'tool.execution_complete', { toolCallId: id, success: true, result: { content: `<command started in background with shellId: ${shellId}>` } }),
  ];
  feed(m, 's', [
    E(0, 'session.start'),
    ...start(1, 'B1', 'make', 'gcc'),
    E(5, 'tool.execution_start', { toolCallId: 'R', toolName: 'read_bash', arguments: { shellId: 'gcc' } }),
    E(5, 'tool.execution_complete', { toolCallId: 'R', success: true, result: { content: 'ok\n<shellId: gcc completed with exit code 0>' } }),
    E(6, 'system.notification', { kind: { type: 'shell_completed', shellId: 'x', exitCode: 0 } }),
    ...start(9, 'B2', 'make test', 'gcc'),
    ...start(9, 'B3', 'serve', 'x'),
  ]);
  assert.deepEqual(view(m, 's').shells.map((x) => [x.id, x.status, x.command]), [['gcc', 'done', 'make'], ['gcc', 'running', 'make test'], ['x', 'running', 'serve']]);

  // The shell before had ended by the time Copilot gave its id to another one.
  feed(m, 'w', [E(0, 'session.start'), ...start(1, 'B5', 'sleep 99', 'z'), ...start(9, 'B6', 'make', 'z')]);
  assert.deepEqual(view(m, 'w').shells.map((x) => [x.id, x.callId, x.status, x.endedAt]), [['z', 'B5', 'done', T0 + 9000], ['z', 'B6', 'running', null]]);

  // The footer of a sync call ends its own shell, which a later shell with the id must not inherit.
  feed(m, 'v', [
    E(0, 'session.start'), E(1, 'session.fusion_resolved'),
    E(2, 'tool.execution_start', { toolCallId: 'S', toolName: 'bash', arguments: { command: 'rm -f app.pid', shellId: 'srv' } }),
    E(2, 'tool.execution_complete', { toolCallId: 'S', success: true, result: { content: '<shellId: srv completed with exit code 0>' } }),
    E(9, 'session.fusion_commit_started'),
    ...start(9, 'B4', 'npm run dev', 'srv'),
  ]);
  assert.deepEqual(view(m, 'v').shells.map((x) => [x.id, x.status]), [['srv', 'running']]);
});

test('the timeline gives background shells lanes under their agent until they end', () => {
  const m = createModel();
  const start = (sec, id, shellId, extra = {}) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'bash', arguments: { command: `run ${shellId}`, mode: 'async', shellId, ...extra } }),
    E(sec + 0.4, 'tool.execution_complete', { toolCallId: id, success: true, result: { content: `<command started in background with shellId: ${shellId}>` } }),
  ];
  const done = (sec, shellId) => E(sec, 'system.notification', { kind: { type: 'shell_completed', shellId, exitCode: 0 } });
  feed(m, 's', [
    E(0, 'session.start'),
    ...start(10, 'B1', 'g0'), ...start(10, 'B2', 'g1'),
    ...start(20, 'B3', 'c'), done(30, 'c'), ...start(60, 'B4', 'c'), done(70, 'c'),
    ...start(80, 'B5', 'srv', { detach: true }),
  ]);
  m.setMeta('s', { alive: true });
  const lanes = (from, to) => lanesOf(view(m, 's'), T0 + from * 1000, T0 + to * 1000);
  const names = (from, to) => lanes(from, to).map((l) => l.kind === 'agent' ? l.agent.key : l.shells.map((x) => x.callId).join(' '));

  // Shells that do not overlap share a lane, and a shellId given again keeps the shell before.
  assert.deepEqual(names(0, 900), ['main', 'B1', 'B2', 'B3 B4 B5']);
  // The calls that started the running shells have left the window.
  assert.deepEqual(names(1000, 1900), ['main', 'B1', 'B2', 'B5']);
  assert.equal(lanes(1000, 1900)[0].calls.length, 0);

  // A restart stops the shells, and the detached one ends where the log lost track of it.
  feed(m, 's', [E(2000, 'session.resume')]);
  assert.deepEqual(names(1500, 2400), ['main', 'B1', 'B2', 'B5']);
  assert.ok(lanes(5000, 5900).every((l) => l.kind === 'agent'));

  // Shells of an auto turn that ended before the commit show where the turn committed, apart.
  feed(m, 'f', [
    E(0, 'session.start'), done(6, 'p'), done(7, 'q'),
    E(400, 'session.fusion_commit_started'), ...start(400, 'F1', 'p'), ...start(400, 'F2', 'q'),
  ]);
  const auto = lanesOf(view(m, 'f'), T0 + 100_000, T0 + 400_000);
  assert.deepEqual(auto.map((l) => l.kind === 'agent' ? l.agent.key : l.shells.map((x) => x.callId).join(' ')), ['main', 'F1', 'F2']);
});

test('the processes of Copilot end the shells that the log never ends', () => {
  const m = createModel();
  const start = (sec, id, command, shellId) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'bash', arguments: { command, mode: 'async', shellId } }, 'A'),
    E(sec, 'tool.execution_complete', { toolCallId: id, success: true, result: { content: `<command started in background with shellId: ${shellId}>` } }, 'A'),
  ];
  // bash keeps its arguments for a pipeline and execs a single command. Copilot may drop the
  // leading cd of a command.
  const P = (pid, sec, ...argv) => ({ pid, ticks: pid * 10, start: T0 + sec * 1000, argv });
  const pipe = P(101, 10.2, '/bin/bash', '--norc', '--noprofile', '-c', 'make 2>&1 | tail');
  const sleep = P(102, 12.4, 'sleep', '30');
  const shells = (sid = 's') => Object.fromEntries(view(m, sid).shells.map((x) => [x.id, [x.status, x.exitCode, x.endedAt]]));
  const check = (procs, sec, sid = 's') => m.checkShells(sid, procs, T0 + sec * 1000);
  feed(m, 's', [E(0, 'session.start'), ...start(10, 'B1', 'cd "/w x" && make 2>&1 | tail', 'a'), ...start(12, 'B2', 'sleep 30', 'b'), ...start(14, 'B3', 'cd x && ./run', 'c')]);

  check([], 20);
  check([], 21);
  assert.equal(shells().c[0], 'running', 'no process has shown how Copilot runs its shells');
  check([pipe, sleep], 22);
  assert.equal(shells().c[0], 'running', '/proc can skip a child once');
  check([pipe, sleep], 23);
  assert.deepEqual(shells(), { a: ['running', null, null], b: ['running', null, null], c: ['done', null, null] });

  check([pipe], 30);
  check([pipe], 31);
  assert.deepEqual(shells().b, ['done', null, T0 + 30_000]);
  feed(m, 's', [E(32, 'system.notification', { kind: { type: 'shell_completed', shellId: 'b', exitCode: 2 } })]);
  assert.deepEqual(shells().b, ['done', 2, T0 + 30_000]);

  // A shell whose command left work in the background still runs without its process.
  feed(m, 's', [
    E(40, 'tool.execution_start', { toolCallId: 'R', toolName: 'read_bash', arguments: { shellId: 'c' } }, 'A'),
    E(40, 'tool.execution_complete', { toolCallId: 'R', success: true, result: { content: '<command with shellId: c is still running after 10 seconds>' } }, 'A'),
  ]);
  check([], 50);
  check([pipe], 51);
  check([], 60);
  check([], 61);
  assert.deepEqual(shells(), { a: ['done', null, T0 + 60_000], b: ['done', 2, T0 + 30_000], c: ['running', null, null] });

  // The processes of one session show how Copilot runs the shells of all sessions on the host.
  feed(m, 't', [E(0, 'session.start'), ...start(70, 'B4', 'sleep 5', 'd')]);
  check([], 80, 't');
  check([], 81, 't');
  assert.deepEqual(shells('t').d, ['done', null, null]);
});

test('a committed auto turn matches its shells to processes only by command, and sessions share no process', () => {
  const m = createModel();
  const start = (sec, id, command, shellId, agentId) => [
    E(sec, 'tool.execution_start', { toolCallId: id, toolName: 'bash', arguments: { command, mode: 'async', shellId } }, agentId),
    E(sec, 'tool.execution_complete', { toolCallId: id, success: true, result: { content: `<command started in background with shellId: ${shellId}>` } }, agentId),
  ];
  // The shells of the main agent appear when its turn commits at 20 s. A subagent logs its own
  // tool calls live. bash execs a single command, whose words a quote no longer shows.
  feed(m, 's', [
    E(0, 'session.start'), E(1, 'session.fusion_resolved'),
    E(20, 'session.fusion_commit_started'), ...start(20, 'B1', 'make | tail', 'a'), ...start(20, 'B2', 'python3 "srv.py"', 'b'),
    ...start(20, 'B5', 'sleep 30', 'd'), E(20, 'session.fusion_completed'),
    ...start(25, 'B4', 'pytest "-q"', 'c', 'A'),
  ]);
  feed(m, 'u', [E(0, 'session.start'), ...start(10, 'B3', 'sleep 40', 'e')]);
  const pipe = { pid: 101, ticks: 1, start: T0 + 10_000, argv: ['bash', '-c', 'make | tail'] };
  const srv = { pid: 102, ticks: 2, start: T0 + 5_000, argv: ['python3', 'srv.py'] };
  const test = { pid: 103, ticks: 3, start: T0 + 25_100, argv: ['pytest', '-q'] };
  const sleep = { pid: 104, ticks: 4, start: T0 + 6_000, argv: ['sleep', '30'] };
  const check = (procs, sec) => {
    m.checkShells('s', procs, T0 + sec * 1000);
    m.checkShells('u', procs, T0 + sec * 1000);
  };
  const shells = (sid) => view(m, sid).shells.map((x) => [x.id, x.status, x.endedAt]);
  check([pipe, srv, test, sleep], 30);
  check([pipe, srv, test, sleep], 31);
  assert.deepEqual(shells('s'), [['a', 'running', null], ['b', 'running', null], ['d', 'running', null], ['c', 'running', null]]);
  assert.deepEqual(shells('u'), [['e', 'done', null]]);
  check([pipe, srv], 40);
  check([pipe, srv], 41);
  assert.deepEqual(shells('s'), [['a', 'running', null], ['b', 'running', null], ['d', 'done', T0 + 40_000], ['c', 'done', T0 + 40_000]]);
  check([pipe], 50);
  check([pipe], 51);
  assert.deepEqual(shells('s'), [['a', 'running', null], ['b', 'done', null], ['d', 'done', T0 + 40_000], ['c', 'done', T0 + 40_000]]);
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
  assert.deepEqual([call(s, 'Q').status, call(s, 'V').status], ['interrupted', 'unknown']);
  assert.equal(agent(s, 'tc:T').phases.at(-1).end, T0 + 3000);
  assert.equal(agent(s, 'tc:U').phases.at(-1).end, T0 + 7000);
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

const startCall = (sec, id, name, args, agentId) => E(sec, 'tool.execution_start', {
  toolCallId: id, toolName: name, arguments: args,
}, agentId);
const finishCall = (sec, id, text, success = true) => E(sec, 'tool.execution_complete', {
  toolCallId: id, result: { content: text }, success,
});
const permission = (sec, requestId, agentId) => E(sec, 'permission.requested', { requestId }, agentId);

test('configuration before a task link survives started and applies only to background turns', () => {
  const m = createModel();
  for (const mode of ['sync', 'background']) {
    feed(m, mode, [
      E(1, 'subagent.configured', { multiTurn: true, reasoningEffort: 'high' }, 'A'),
      E(2, 'subagent.started', { toolCallId: 'T', executionMode: mode, resumable: false }, 'A'),
      startCall(3, 'Q', 'ask_user', {}, 'A'), permission(4, 'p', 'A'),
      E(5, 'subagent.completed', { toolCallId: 'T' }, 'A'),
    ]);
    const a = agent(view(m, mode), 'tc:T');
    assert.equal(a.effort, 'high');
    assert.equal(a.display, mode === 'sync' ? 'done' : 'idle');
    assert.equal(a.current, null);
  }
  feed(m, 'background', [startCall(6, 'W', 'write_agent', { agent_id: 'A' }), finishCall(7, 'W', '')]);
  assert.equal(agent(view(m, 'background'), 'tc:T').display, 'running');
});

test('late background completion preserves failure and cancellation', () => {
  const m = createModel();
  for (const status of ['failed', 'cancelled']) {
    feed(m, status, [
      E(1, 'subagent.started', { toolCallId: 'T', executionMode: 'background', resumable: true }, 'A'),
      status === 'failed' ? E(2, 'subagent.failed', {}, 'A') : E(2, 'subagent.completed', { cancelled: true }, 'A'),
      E(3, 'subagent.completed', {}, 'A'),
    ]);
    assert.equal(agent(view(m, status), 'tc:T').status, status);
  }
});

test('a fork includes the copied main phases without rebasing an ordinary delayed event', () => {
  const m = createModel();
  feed(m, 'fork', [E(60, 'session.start'), E(1, 'user.message'), E(4, 'assistant.turn_end'),
    E(8, 'user.message'), E(61, 'user.message'), E(62, 'session.info', { infoType: 'fork' }), E(63, 'session.resume')]);
  const s = view(m, 'fork');
  assert.equal(s.meta.startedAt, T0 + 1000);
  assert.deepEqual(agent(s, 'main').phases.map((p) => [p.state, (p.start - T0) / 1000, p.end && (p.end - T0) / 1000]),
    [['thinking', 1, 4], ['idle', 4, 8], ['thinking', 8, 60], ['idle', 60, 61], ['thinking', 61, 63], ['idle', 63, null]]);
  feed(m, 'normal', [E(20, 'session.start'), E(19.9, 'user.message'), E(22, 'assistant.turn_end')]);
  assert.equal(view(m, 'normal').meta.startedAt, T0 + 20000);
  assert.deepEqual(agent(view(m, 'normal'), 'main').phases, [{ state: 'idle', start: T0 + 20000, end: null }]);
});

test('fusion completion settles only its own live main work', () => {
  const m = createModel();
  for (const outcome of ['success', 'failed', 'aborted', 'superseded', 'newFusion']) {
    feed(m, outcome, [E(1, 'session.fusion_resolved', { fusionId: 'f' }), E(2, 'user.message'),
      hook(3, 'agentStop', {}), E(4, 'session.fusion_commit_started', { fusionId: 'f' }),
      hook(5, 'preToolUse', { toolCalls: [{ id: 'B', name: 'bash' }] })]);
    if (outcome === 'aborted') m.ingest(outcome, E(6, 'abort'));
    if (outcome === 'superseded') feed(m, outcome, [E(6, 'user.message'), startCall(7, 'N', 'view')]);
    if (outcome === 'newFusion') feed(m, outcome, [E(6, 'abort'), E(6, 'session.fusion_resolved', { fusionId: 'g' }),
      E(7, 'user.message'), E(7, 'session.fusion_commit_started', { fusionId: 'g' }), startCall(7, 'N', 'view')]);
    m.ingest(outcome, E(8, 'session.fusion_completed', { fusionId: 'f', outcome }));
    const s = view(m, outcome);
    assert.equal(agent(s, 'main').display, { success: 'idle', failed: 'failed', aborted: 'cancelled', superseded: 'running', newFusion: 'running' }[outcome]);
    if (outcome === 'superseded' || outcome === 'newFusion') assert.equal(call(s, 'N').status, 'running');
    else assert.notEqual(call(s, 'B').status, 'running');
  }
});

test('a session error ends replay and clears interrupted main work', () => {
  const m = createModel();
  feed(m, 's', [startCall(1, 'B', 'bash'), finishCall(2, 'B', '<command started in background with shellId: b>'),
    startCall(3, 'Q', 'ask_user'), permission(4, 'p'), E(5, 'session.fusion_commit_started'), E(6, 'session.error')]);
  assert.equal(m.wantsShellCheck('s'), true);
  assert.equal(call(view(m, 's'), 'Q').status, 'interrupted');
  m.ingest('s', E(7, 'user.message'));
  assert.equal(agent(view(m, 's'), 'main').display, 'running');
});

test('a human answer ends the input phase before the committed outcome arrives', () => {
  const m = createModel();
  const answer = (sec) => E(sec, 'human_response.recorded', { requestId: 'r', toolCallId: 'Q', actor: 'human_response', response: {} });
  feed(m, 's', [hook(1, 'preToolUse', { toolCalls: [{ id: 'Q', name: 'ask_user' }] }), answer(2)].filter((ev) => HANDLED_TYPES.has(ev.type)));
  const s = view(m, 's');
  assert.equal(call(s, 'Q').status, 'ok');
  assert.equal(agent(s, 'main').phases.at(-1).state, 'thinking');
  feed(m, 's', [finishCall(3, 'Q', 'failed', false), answer(4)]);
  assert.equal(call(view(m, 's'), 'Q').status, 'failed');
});

test('only a shell marker on the final line follows partial stdout', () => {
  const m = createModel();
  const marker = '<command with shellId: b is still running after 30 seconds>';
  feed(m, 's', [startCall(1, 'A', 'bash'), finishCall(2, 'A', `${marker}\nmore`),
    startCall(3, 'B', 'bash'), finishCall(4, 'B', `progress\n${marker}`)]);
  assert.deepEqual(view(m, 's').shells.map((s) => s.callId), ['B']);
});

test('a raw patch names the edited file in the call summary', () => {
  const m = createModel();
  m.ingest('s', startCall(1, 'P', 'apply_patch', '*** Begin Patch\n*** Update File: src/example.js\n@@\n-x\n+y\n*** End Patch'));
  assert.equal(call(view(m, 's'), 'P').summary, 'src/example.js');
});

test('abort follows sync task children but leaves a background subtree alone', () => {
  const m = createModel();
  for (const [id, mode, parent] of [['S', 'sync'], ['X', 'sync', 'S'], ['B', 'background'], ['Y', 'sync', 'B']]) {
    feed(m, 's', [startCall(1, id, 'task', { mode }, parent), E(2, 'subagent.started', { toolCallId: id }, id),
      startCall(3, `Q${id}`, 'ask_user', {}, id), permission(4, `p${id}`, id)]);
  }
  m.ingest('s', E(6, 'abort'));
  const s = view(m, 's');
  for (const id of ['S', 'X', 'B', 'Y']) {
    const a = agent(s, `tc:${id}`);
    if (id === 'S' || id === 'X') {
      assert.equal(a.status, 'cancelled');
      assert.equal(call(s, `Q${id}`).status, 'interrupted');
      assert.equal(a.phases.at(-1).end, T0 + 6000);
    } else {
      assert.equal(a.display, 'input');
      assert.equal(a.phases.at(-1).end, null);
    }
  }
});

test('permissions follow a placeholder and stop waiting at a turn boundary', () => {
  const m = createModel();
  feed(m, 's', [permission(1, 'p', 'A'), E(2, 'subagent.started', { toolCallId: 'T' }, 'A')]);
  assert.equal(agent(view(m, 's'), 'tc:T').display, 'waiting');
  m.ingest('s', E(3, 'permission.completed', { requestId: 'p' }));
  assert.equal(agent(view(m, 's'), 'tc:T').display, 'running');
  for (const end of [hook(5, 'agentStop', {}), E(5, 'abort')]) {
    feed(m, 's', [E(4, 'user.message'), permission(4, 'unknown'), end, E(6, 'user.message')]);
    assert.equal(agent(view(m, 's'), 'main').display, 'running');
  }
});

test('numeric and string call references join and malformed IDs create no calls', () => {
  const m = createModel();
  feed(m, 's', [hook(1, 'preToolUse', { toolCalls: [{ id: 0, name: 'view' }, { id: {}, name: 'bash' }] }),
    E(2, 'permission.requested', { requestId: 'p', permissionRequest: { toolCallId: 0 } }),
    E(3, 'tool.execution_start', { toolCallId: 42, toolName: 'ask_user', parentToolCallId: 7 }),
    E(4, 'human_response.recorded', { toolCallId: '42' }), finishCall(5, '0', ''), startCall(6, [], 'bash')]);
  const s = view(m, 's');
  assert.deepEqual(s.calls.map((c) => [c.id, c.agent, c.status]), [['0', 'main', 'ok'], ['42', 'tc:7', 'ok']]);
});

test('failed shell controls and truncated read output do not end a running shell', () => {
  const m = createModel();
  const wrapper = 'Output too large to read at once (32 KB). Saved to: output.txt\nPreview (first 500 chars):\npartial';
  feed(m, 's', [startCall(1, 'B', 'bash'), finishCall(2, 'B', '<command started in background with shellId: b>')]);
  for (const [name, text, ok] of [['read_bash', '', false], ['stop_bash', '', false], ['read_bash', wrapper, true], ['stop_bash', wrapper, true]]) {
    const id = name + ok;
    feed(m, 's', [startCall(3, id, name, { shellId: 'b' }), finishCall(4, id, text, ok)]);
    assert.equal(view(m, 's').shells[0].status, 'running');
  }
  feed(m, 's', [startCall(5, 'R', 'read_bash', { shellId: 'b' }), finishCall(6, 'R', `${wrapper}\n<shellId: b completed with exit code 1>`)]);
  assert.equal(view(m, 's').shells[0].exitCode, 1);
});

test('committed arguments fill call details after a live call received an intent', () => {
  const m = createModel();
  feed(m, 's', [hook(1, 'preToolUse', { toolCalls: [{ id: 'B', name: 'bash' }] }), E(2, 'session.fusion_commit_started'),
    E(3, 'assistant.message', { toolRequests: [{ toolCallId: 'B', intentionSummary: 'Inspect' }] }),
    startCall(4, 'B', 'bash', { command: 'pwd', description: 'Show directory' })]);
  const d = m.callDetail('s', 'B');
  assert.deepEqual([d.summary, d.intent, d.command], ['Show directory', 'Inspect', 'pwd']);
});

test('a turn with no assistant message does not inherit the previous tool requests', () => {
  const m = createModel();
  feed(m, 's', [E(1, 'assistant.turn_start'), E(2, 'assistant.message', { toolRequests: [{ toolCallId: 'T' }] }),
    E(3, 'assistant.turn_end'), E(4, 'assistant.turn_start'), E(5, 'assistant.turn_end')]);
  assert.equal(agent(view(m, 's'), 'main').status, 'idle');
});

test('a burst of concurrent calls is trimmed as the calls end', () => {
  const m = createModel();
  for (let i = 0; i < LIMITS.calls + 2; i++) m.ingest('s', startCall(1, `C${i}`, 'view'));
  feed(m, 's', [finishCall(2, 'C1', ''), finishCall(3, 'C2', '')]);
  const s = view(m, 's');
  assert.equal(s.calls.length, LIMITS.calls);
  assert.ok(s.calls.every((c) => c.status === 'running'));
});

test('the main turn timer follows main prompts even after the feed drops them', () => {
  const m = createModel();
  m.ingest('s', E(0, 'session.start'));
  assert.equal(agent(view(m, 's'), 'main').turnStartedAt, null);
  feed(m, 's', [E(1, 'user.message'), E(3, 'user.message'), E(4, 'user.message', {}, 'A'),
    E(4, 'user.message', { parentToolCallId: 'T' }), E(5, 'assistant.turn_start')]);
  for (let i = 0; i <= LIMITS.feed; i++) m.ingest('s', E(6, 'assistant.message', { content: 'working' }));
  assert.equal(agent(view(m, 's'), 'main').turnStartedAt, T0 + 3000);
});

test('invalid log times and numbers do not invalidate a browser snapshot', () => {
  const m = createModel();
  feed(m, 's', [
    { ...E(0, 'session.start', { context: { cwd: {} }, startTime: -1e18 }), timestamp: 1e18 },
    { ...E(0, 'user.message', { content: 'hello' }), timestamp: -1e18 },
    E(1, 'session.usage_checkpoint', { totalNanoAiu: 2e9, totalPremiumRequests: 1 }),
    E(2, 'session.usage_checkpoint', { totalNanoAiu: Infinity, totalPremiumRequests: NaN }),
    E(3, 'session.usage_record', { inputTokens: Infinity, outputTokens: Number.MAX_VALUE }),
    E(4, 'session.usage_record', { inputTokens: 7, outputTokens: Number.MAX_VALUE }),
    E(5, 'subagent.completed', { totalToolCalls: Infinity, totalTokens: NaN, durationMs: 'unknown' }, 'A'),
    startCall(6, 'B', 'bash'),
    E(7, 'tool.execution_complete', { toolCallId: 'B', shellExecution: { exitCode: NaN }, result: '<command started in background with shellId: b>' }),
    E(8, 'system.notification', { kind: { type: 'shell_completed', shellId: 'b', exitCode: Infinity } }),
    E(9, 'session.shutdown', { accountingSnapshot: { totalNanoAiu: Infinity } }),
  ]);
  const snap = m.snapshot();
  assert.equal(createStore().apply({ type: 'snapshot', ...snap }), true);
  const [s] = snap.sessions;
  assert.deepEqual([s.feed[0].ts, s.meta.startedAt, s.meta.cwd, s.meta.aic, s.meta.premium], [null, null, null, 2, 1]);
  assert.deepEqual(agent(s, 'main').tokens, { input: 7, output: Number.MAX_VALUE, cacheRead: 0 });
  const a = agent(s, 'aid:A');
  assert.deepEqual([a.toolCount, a.reportedTokens, a.durationMs, call(s, 'B').exitCode, s.shells[0].exitCode], [0, null, null, null, null]);
});

test('fusion routing between a prompt hook and its message still owns the prompt', () => {
  const m = createModel();
  feed(m, 's', [E(0, 'session.start', { selectedModel: 'auto' }), hook(1, 'userPromptSubmitted', {}),
    E(2, 'session.fusion_resolved', { fusionId: 'f' }), E(3, 'user.message', { content: 'go' }),
    hook(4, 'preToolUse', { toolCalls: [{ id: 'B', name: 'bash' }] }),
    E(5, 'session.fusion_completed', { fusionId: 'f', outcome: 'failed' })]);
  const s = view(m, 's');
  assert.equal(agent(s, 'main').status, 'failed');
  assert.equal(call(s, 'B').status, 'interrupted');
});
