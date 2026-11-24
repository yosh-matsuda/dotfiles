import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, open, symlink, writeFile, appendFile, rename, truncate, rm, utimes } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCollector } from './collector.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitor, isCopilotArgv, parseWorkspaceYaml, psOwnsLock, shellProcs } from './monitor.mjs';

function fakeModel() {
  const m = { events: [], resets: 0, meta: {} };
  m.ingest = (sid, ev) => m.events.push(ev);
  m.setMeta = (sid, patch) => Object.assign(m.meta, patch);
  m.resetSession = () => {
    m.resets++;
    m.events.length = 0;
  };
  m.removeSession = () => {};
  return m;
}

const line = (type, data) => `${JSON.stringify({ type, data, timestamp: '2026-01-01T00:00:00Z' })}\n`;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'copilot-viz-test-'));
  const dir = join(home, 'session-state', 'sid');
  await mkdir(dir, { recursive: true });
  return { home, dir, log: join(dir, 'events.jsonl') };
}

test('reads lines whose bytes are split between reads', async (t) => {
  const { home, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const model = fakeModel();
  const mon = createMonitor({ model, home, chunkSize: 5 });
  await writeFile(log, line('user.message', { content: 'こんにちは、世界' }) + line('assistant.reasoning', { content: 'skip' }));
  await appendFile(log, line('assistant.message', { content: '途中' }).slice(0, 30));
  await mon.sync();
  assert.deepEqual(model.events.map((e) => e.data.content), ['こんにちは、世界']);

  await appendFile(log, line('assistant.message', { content: '途中' }).slice(30));
  await mon.sync();
  assert.deepEqual(model.events.map((e) => e.data.content), ['こんにちは、世界', '途中']);
  assert.equal(model.resets, 0);
});

test('a failed discovery retains sessions instead of treating the host as empty', { skip: process.getuid?.() === 0 }, async (t) => {
  const { home, dir, log } = await setup();
  t.after(async () => {
    await chmod(join(home, 'session-state'), 0o700);
    await chmod(dir, 0o700);
    await rm(home, { recursive: true, force: true });
  });
  const model = fakeModel();
  let removed = 0;
  model.removeSession = () => { removed++; };
  const mon = createMonitor({ model, home });
  await writeFile(log, line('user.message', { content: 'keep this' }));
  await mon.sync();
  await chmod(dir, 0);
  await assert.rejects(mon.sync(), { code: 'EACCES' });
  assert.equal(removed, 0);
  await chmod(dir, 0o700);
  await chmod(join(home, 'session-state'), 0);
  await assert.rejects(mon.start(), { code: 'EACCES' });
  assert.equal(mon.ready, false);
  assert.equal(removed, 0);
  mon.stop();
});

test('a replaced or truncated log is read again from the start', async (t) => {
  const { home, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const model = fakeModel();
  const mon = createMonitor({ model, home });
  await writeFile(log, line('user.message', { content: 'one' }) + line('user.message', { content: 'two' }));
  await mon.sync();

  await writeFile(`${log}.new`, line('user.message', { content: 'three' }));
  await rename(`${log}.new`, log);
  await mon.sync();
  assert.equal(model.resets, 1);
  assert.deepEqual(model.events.map((e) => e.data.content), ['three']);

  await truncate(log, 0);
  await appendFile(log, line('user.message', { content: 'four' }));
  await mon.sync();
  assert.equal(model.resets, 2);
  assert.deepEqual(model.events.map((e) => e.data.content), ['four']);
});

test('a log rewritten in place is read again from the start', async (t) => {
  const { home, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const model = fakeModel();
  const mon = createMonitor({ model, home });
  await writeFile(log, line('user.message', { content: 'one' }));
  await mon.sync();

  await writeFile(log, line('user.message', { content: 'two' }) + line('user.message', { content: 'three' }));
  await mon.sync();
  assert.equal(model.resets, 1);
  assert.deepEqual(model.events.map((e) => e.data.content), ['two', 'three']);

  // The same size, so only the new mtime shows the change.
  await writeFile(log, line('user.message', { content: 'four' }) + line('user.message', { content: 'five' }));
  const later = new Date(Date.now() + 60_000);
  await utimes(log, later, later);
  await mon.sync();
  assert.equal(model.resets, 2);
  assert.deepEqual(model.events.map((e) => e.data.content), ['four', 'five']);
});

test('a log rewritten to the same size and the same end is read again on the next look', async (t) => {
  const { home, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const model = fakeModel();
  const mon = createMonitor({ model, home });
  const last = 'a last line that stays the same and is longer than the tail';
  await writeFile(log, line('user.message', { content: 'one' }) + line('user.message', { content: last }));
  await mon.sync();

  await writeFile(log, line('user.message', { content: 'two' }) + line('user.message', { content: last }));
  const later = new Date(Date.now() + 60_000);
  await utimes(log, later, later);
  // A write in progress also has a new mtime and the old size at first.
  await mon.sync();
  assert.equal(model.resets, 0);
  await mon.sync();
  assert.equal(model.resets, 1);
  assert.deepEqual(model.events.map((e) => e.data.content), ['two', last]);
});

test('tells Copilot from other processes by their arguments', () => {
  const yes = [
    ['/home/u/.vscode-server/extensions/x/node_modules/@github/copilot-sdk-linux-arm64/prebuilds/linux-arm64/copilot-runtime', '--headless'],
    ['/home/linuxbrew/.linuxbrew/bin/copilot', '--resume'],
    ['copilot.exe'],
    ['node', '/usr/lib/node_modules/@github/copilot/index.js'],
    ['/usr/bin/node', '--no-warnings', '/home/u/.npm-global/bin/copilot', '-p', 'hi'],
    ['node', '--require', '/opt/preload.cjs', '/usr/bin/copilot'],
    ['deno', 'run', '-A', '/opt/node_modules/@github/copilot/index.js'],
  ];
  const no = [
    [''],
    ['node', '/home/u/dotfiles/files/scripts/copilot-viz/cli.mjs', 'serve'],
    ['node', '--require', '/opt/preload.cjs', '/srv/app.js'],
    ['vim', '/home/u/.copilot/session-state/x/events.jsonl'],
    ['less', '/usr/lib/node_modules/@github/copilot/index.js'],
    ['/usr/bin/copilot-viz'],
  ];
  for (const argv of yes) assert.equal(isCopilotArgv(argv), true, argv.join(' '));
  for (const argv of no) assert.equal(isCopilotArgv(argv), false, argv.join(' '));
});

test('reads the names that Copilot writes to workspace.yaml', () => {
  const y = parseWorkspaceYaml([
    'id: 0c676a7b',
    'name: |-',
    '  https://herdrui.dev/',
    '',
    '  二行目',
    "summary: 'it''s: quoted'",
    'cwd: /home/u/w # comment',
    'user_named: false',
  ].join('\n'));
  assert.equal(y.name, 'https://herdrui.dev/\n\n二行目');
  assert.equal(y.summary, "it's: quoted");
  assert.equal(y.cwd, '/home/u/w');
  assert.equal(y.user_named, 'false');
});

test('shellProcs lists the children that lead their own session', { skip: !existsSync(`/proc/self/task/${process.pid}/children`) }, async (t) => {
  const shell = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const tool = spawn('sleep', ['31'], { stdio: 'ignore' });
  t.after(() => {
    shell.kill();
    tool.kill();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const procs = await shellProcs(process.pid);
  const p = procs.find((x) => x.pid === shell.pid);
  assert.deepEqual(p.argv, ['sleep', '30']);
  assert.ok(Math.abs(p.start - Date.now()) < 5000, `starts at ${new Date(p.start).toISOString()}`);
  assert.ok(Number.isInteger(p.ticks));
  assert.equal(procs.some((x) => x.pid === tool.pid), false);
});

test('ps elapsed time distinguishes a lock owner from a reused PID', () => {
  const now = 200_000_000;
  for (const [time, seconds] of [['01:02', 62], ['03:01:02', 10862], ['1-03:01:02', 97262]]) {
    const lock = now - seconds * 1000;
    assert.equal(psOwnsLock(`  ${time} /bin/copilot --resume`, lock - 1999, now), true);
    assert.equal(psOwnsLock(`${time} /bin/copilot`, lock - 2001, now), false);
    assert.equal(psOwnsLock(`${time} /bin/sleep`, lock, now), false);
  }
  assert.equal(psOwnsLock('unknown /bin/copilot', now, now), null);
});

test('workspace block scalars accept either order of indentation and chomping', () => {
  for (const header of ['|2-', '|-2']) assert.equal(parseWorkspaceYaml(`name: ${header}\n  one\n  two`).name, 'one\ntwo');
});

test('failed lock listings and workspace reads are retried without an mtime change', { skip: process.getuid?.() === 0 }, async (t) => {
  const { home, dir, log } = await setup();
  const yaml = join(dir, 'workspace.yaml');
  t.after(() => rm(home, { recursive: true, force: true }));
  const model = fakeModel();
  const errors = [];
  const mon = createMonitor({ model, home, onError: (e) => errors.push(e) });
  await writeFile(log, '');
  await writeFile(yaml, 'name: recovered', { mode: 0 });
  await chmod(dir, 0o300);
  try {
    await mon.sync();
    assert.equal(model.meta.alive, null);
    assert.equal(errors[0]?.code, 'EACCES');
  } finally {
    await chmod(dir, 0o700);
    await chmod(yaml, 0o600);
  }
  await mon.sync();
  assert.equal(model.meta.alive, false);
  assert.equal(model.meta.name, 'recovered');
});

test('an unreadable hold path or foreign process is not proof of ownership', { skip: !existsSync('/proc/self/cmdline') }, async (t) => {
  const { home, dir, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '/bin/copilot']);
  t.after(() => proc.kill());
  await once(proc, 'spawn');
  await writeFile(join(dir, `inuse.${proc.pid}.lock`), '');
  const hold = `inuse.${proc.pid}.hold`;
  await symlink(hold, join(dir, hold));
  await writeFile(log, '');
  const model = fakeModel();
  const mon = createMonitor({ model, home });
  await mon.sync();
  assert.equal(model.meta.alive, null);
  await rm(join(dir, hold));
  t.mock.method(process, 'getuid', () => -1);
  await mon.sync();
  assert.equal(model.meta.alive, false);
});

test('collector publishes a finished running session while the next file is still opening', { timeout: 5000 }, async (t) => {
  const { home, dir, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', '/bin/copilot']);
  await once(proc, 'spawn');
  t.after(() => proc.kill());
  await writeFile(join(dir, `inuse.${proc.pid}.lock`), '');
  await writeFile(log, line('session.start', {}));
  const other = join(home, 'session-state', 'slow');
  await mkdir(other);
  const fifo = join(other, 'events.jsonl');
  execFileSync('mkfifo', [fifo]);
  const messages = [];
  const collector = createCollector({ home, onMessage: (m) => messages.push(m) });
  t.after(() => collector.stop());
  const started = collector.start();
  try {
    for (const until = Date.now() + 3000; !messages.length && Date.now() < until;) await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(messages[0]?.sessions.map((s) => s.id), ['sid']);
    assert.deepEqual(collector.snapshot().sessions.map((s) => s.id), ['sid']);
  } finally {
    await (await open(fifo, 'w')).close();
    await started;
  }
  assert.deepEqual(collector.snapshot().sessions.map((s) => s.id).sort(), ['sid', 'slow']);
});

test('collector clears timers after startup fails', async (t) => {
  const { home, log } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(log, '');
  const timers = new Set();
  t.mock.method(globalThis, 'setInterval', () => { const timer = {}; timers.add(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', (timer) => timers.delete(timer));
  const collector = createCollector({ home: log });
  await assert.rejects(collector.start(), { code: 'ENOTDIR' });
  assert.equal(timers.size, 0);
});

test('an empty collector announces ready when a blocked flush resumes', async (t) => {
  const { home } = await setup();
  t.after(() => rm(home, { recursive: true, force: true }));
  const messages = [];
  let blocked = true;
  const collector = createCollector({ home, canFlush: () => !blocked, onMessage: (m) => messages.push(m) });
  t.after(() => collector.stop());
  await collector.start();
  assert.deepEqual(messages, []);
  blocked = false;
  collector.flush();
  collector.flush();
  assert.deepEqual(messages.map((m) => [m.type, m.ready]), [['status', true]]);
});
