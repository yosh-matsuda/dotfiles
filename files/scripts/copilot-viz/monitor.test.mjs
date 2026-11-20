import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, appendFile, rename, truncate, rm, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitor, isCopilotArgv, parseWorkspaceYaml, shellProcs } from './monitor.mjs';

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
