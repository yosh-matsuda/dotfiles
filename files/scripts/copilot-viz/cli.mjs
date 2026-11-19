#!/usr/bin/env node
// copilot-viz: a browser dashboard of the agents, subagents, and tool calls of Copilot CLI sessions.

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseDuration } from './monitor.mjs';
import { loadRemotes } from './remote.mjs';
import { codeVersion, control, DEFAULT_PORT, HERE, running, runtimeDir, socketPath } from './runtime.mjs';

const USAGE = `Usage: copilot-viz [open] [--port N] [--since DURATION] [--no-open]
       copilot-viz serve [--port N] [--since DURATION] [--idle-exit MINUTES]
       copilot-viz status
       copilot-viz stop

Shows the agents, subagents, and tool calls of Copilot CLI sessions in a browser.

  open         start the server when it is not running, and open a new link (default)
  serve        run the server in the foreground
  status       show the running server
  stop         stop the running server

  --port       port on 127.0.0.1 (default ${DEFAULT_PORT}; a free port when it is taken)
  --since      show the sessions whose log changed within this time, e.g. 90m, 24h, 7d
               (default 24h); running sessions are always shown
  --no-open    print the link without opening a browser
  --idle-exit  with serve, stop after this many minutes without a viewer (default never)`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (msg) => process.stderr.write(`copilot-viz: ${msg}\n`);

function options() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, since: { type: 'string' }, 'no-open': { type: 'boolean' },
      'idle-exit': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (positionals.length > 1) throw new Error(`unexpected argument: ${positionals[1]}`);
  const command = positionals[0] ?? 'open';
  if (!['open', 'serve', 'status', 'stop'].includes(command)) throw new Error(`unknown command: ${command}`);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new Error(`bad --port: ${values.port}`);
  const sinceMs = values.since === undefined ? undefined : parseDuration(values.since);
  if (sinceMs === null) throw new Error(`bad --since: ${values.since}`);
  const idle = values['idle-exit'] === undefined ? 0 : Number(values['idle-exit']);
  if (!(idle >= 0)) throw new Error(`bad --idle-exit: ${values['idle-exit']}`);
  return { command, port, sinceMs, since: values.since, noOpen: values['no-open'] ?? false, idleExitMs: idle * 60_000 };
}

// Waits until the server of this PID left the socket and exited, so its port is free again.
async function waitGone(sock, pid, deadline) {
  for (;;) {
    const st = await control(sock, 'GET', '/status', 1000).catch(() => null);
    if (st?.body?.pid !== pid && !running(pid)) return;
    if (Date.now() >= deadline) throw new Error(`the server (pid ${pid}) did not stop`);
    await sleep(100);
  }
}

function spawnServer(logPath, opt) {
  try {
    if (statSync(logPath).size > 1 << 20) truncateSync(logPath, 0);
  } catch {
    // No log yet.
  }
  const args = [join(HERE, 'cli.mjs'), 'serve', '--idle-exit', '30'];
  if (opt.port !== undefined) args.push('--port', String(opt.port));
  if (opt.since !== undefined) args.push('--since', opt.since);
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
}

function logTail(logPath) {
  try {
    return readFileSync(logPath, 'utf8').split('\n').slice(-10).join('\n');
  } catch {
    return '';
  }
}

// Why a running server does not fit this open, or null. A server that asked for a port and got
// another one, because that port was taken, still fits.
function difference(st, opt, version) {
  if (st.version !== version) return 'its code changed';
  if (JSON.stringify(st.remotes ?? []) !== JSON.stringify(opt.remotes)) return 'its remote configuration changed';
  if (opt.port !== undefined && st.requestedPort !== opt.port) return `--port ${opt.port}`;
  if (opt.sinceMs !== undefined && st.sinceMs !== opt.sinceMs) return `--since ${opt.since}`;
  return null;
}

function browserCommand(url) {
  const env = process.env;
  const browser = env.BROWSER?.split(':').find((x) => x.trim());
  if (browser) {
    const script = browser.includes('%s') ? browser.replaceAll('%s', '"$1"') : `${browser} "$1"`;
    return { cmd: '/bin/sh', args: ['-c', script, 'sh', url] };
  }
  // explorer.exe takes a URL for a path and can open a File Explorer window instead of the
  // browser; url.dll hands the URL to ShellExecute, which opens the default Windows browser.
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

function openBrowser(url) {
  const { cmd, args } = browserCommand(url);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// Another open may start or restart the server at the same time; the server that keeps the
// socket serves both.
async function open(dir, sock, opt) {
  opt.remotes = await loadRemotes();
  const version = await codeVersion();
  const logPath = join(dir, 'server.log');
  const deadline = Date.now() + 15_000;
  const left = () => Math.max(deadline - Date.now(), 1);
  // A server that is stopping may close the connection before it replies. The request is then
  // undefined and made again, until the deadline.
  const ask = (method, path) => control(sock, method, path, left()).catch((e) => {
    if (Date.now() >= deadline) throw e;
    return undefined;
  });
  let spawned = false;
  let restarted = false;
  let reply;
  for (;;) {
    const r = await ask('GET', '/status');
    if (r === undefined) {
      await sleep(100);
      continue;
    }
    const st = r?.body ?? null;
    const why = st && difference(st, opt, version);
    if (!st) {
      if (!spawned) spawnServer(logPath, opt);
      spawned = true;
    } else if (why && !spawned && !restarted) {
      say(`restarting the server for ${why}`);
      restarted = true;
      await ask('POST', `/stop?pid=${st.pid}`);
      await waitGone(sock, st.pid, deadline);
      continue;
    } else if (st.port) {
      const l = await ask('POST', '/launch');
      if (l?.status === 200) {
        if (why) say(`another copilot-viz started the server first, so it ignores ${why}`);
        reply = l.body;
        break;
      }
      if (l && l.status !== 503) throw new Error(`the server gave no link: ${JSON.stringify(l.body)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(spawned ? `the server did not start; ${logPath} ends with:\n${logTail(logPath)}` : 'the server did not answer');
    }
    await sleep(100);
  }
  const url = reply.launch;
  process.stdout.write(`${url}\n`);
  if (process.env.SSH_CONNECTION) {
    say(`on your machine, forward the port first: ssh -L ${reply.port}:127.0.0.1:${reply.port} ${hostname()}`);
  }
  if (!opt.noOpen && !(await openBrowser(url))) say('no browser opened; open the link above (it works once, for 2 minutes)');
}

async function main() {
  const opt = options();
  const dir = await runtimeDir();
  const sock = socketPath(dir);
  switch (opt.command) {
    case 'open':
      return open(dir, sock, opt);
    case 'serve': {
      let server;
      try {
        server = await (await import('./server.mjs')).startServer({ port: opt.port, sinceMs: opt.sinceMs, idleExitMs: opt.idleExitMs });
      } catch (e) {
        if (e.code !== 'RUNNING') throw e;
        const st = (await control(sock, 'GET', '/status'))?.body;
        say(`already running at ${st?.url ?? '?'} (pid ${st?.pid ?? '?'})`);
        return undefined;
      }
      say(`open ${server.launchUrl()} (it works once, for 2 minutes)`);
      return undefined;
    }
    case 'status': {
      const st = (await control(sock, 'GET', '/status'))?.body;
      if (!st) {
        say('not running');
        process.exitCode = 1;
        return undefined;
      }
      const outdated = st.version !== (await codeVersion()) ? ' (older code; the next open restarts it)' : '';
      const mins = (ms) => `${Math.round(ms / 60_000)}m`;
      process.stdout.write([
        `running at ${st.url} (pid ${st.pid})${outdated}`,
        `up ${mins(Date.now() - st.startedAt)}, ${st.sessions} sessions, ${st.clients} viewers, ${st.ready ? 'ready' : 'loading'}, ${st.errors} errors`,
        `since ${mins(st.sinceMs)}, idle exit ${st.idleExitMs ? mins(st.idleExitMs) : 'never'}`,
        ...(st.hosts ?? []).filter((h) => h.remote).map((h) => `${h.name}: ${h.state}${h.error ? ` (${h.error})` : ''}`),
      ].join('\n') + '\n');
      return undefined;
    }
    case 'stop': {
      const st = (await control(sock, 'GET', '/status'))?.body;
      if (!st) {
        say('not running');
        return undefined;
      }
      const r = await control(sock, 'POST', `/stop?pid=${st.pid}`);
      if (r?.status === 409) throw new Error('another server replaced it meanwhile; run stop again');
      await waitGone(sock, st.pid, Date.now() + 5000);
      say('stopped');
      return undefined;
    }
    default:
      return undefined;
  }
}

main().catch((e) => {
  say(e.message);
  process.exitCode = 1;
});
