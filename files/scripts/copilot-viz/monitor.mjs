// Follows the event logs under <COPILOT_HOME>/session-state and feeds them to the model.
// Lines are split as bytes, so a UTF-8 character split between two reads stays intact.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HANDLED_TYPES } from './model.mjs';

const TYPE_RE = /^\{"type":"([^"\\]+)"/;
const LOCK_RE = /^inuse\.(\d+)\.lock$/;
const MAX_LINE = 32 * 1024 * 1024;
const LOCK_RECHECK_MS = 60_000;
// The bytes before the read position that must stay the same while a log only grows.
const TAIL = 64;
const NO_BYTES = Buffer.alloc(0);
const COPILOT_BIN = /^copilot(?:-runtime)?(?:\.exe)?$/;
const COPILOT_PKG = /[\\/]@github[\\/]copilot[\\/]/;
const SCRIPT_RUNNER = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/;
// ps joins the arguments with spaces, and a path may hold spaces too.
const COPILOT_ARGS = /(?:^|[\\/])copilot(?:-runtime)?(?:\s|$)|[\\/]@github[\\/]copilot[\\/]/;
const HAS_PROC = existsSync('/proc/self/cmdline');
const HAS_CHILDREN = existsSync(`/proc/self/task/${process.pid}/children`);
// USER_HZ, the unit of the start times in /proc; Linux reports 100 on every architecture.
const CLOCK_TICKS = 100;

export function copilotHome(env = process.env) {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

export const validSessionId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/') && !id.startsWith('.');

// Copilot runs as its own binary, or as a script of node, bun, or deno. Options of the runner,
// with or without a value, and its subcommands may come before the script, so any argument may
// name it. The hold file, not the arguments, tells Copilot from a process that reused its PID.
export function isCopilotArgv(argv) {
  const is = (a) => COPILOT_BIN.test(basename(a)) || COPILOT_PKG.test(a);
  if (!argv[0]) return false;
  if (is(argv[0])) return true;
  return SCRIPT_RUNNER.test(basename(argv[0])) && argv.slice(1).some(is);
}

// Copilot keeps inuse.<pid>.hold open while it runs, unlike a process that got the PID of a
// Copilot that died. null when the descriptors of the process cannot be read.
async function holdsFile(pid, path) {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => null);
  if (!fds) return null;
  for (const fd of fds) if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null)) === path) return true;
  return false;
}

// ps prints elapsed time as [[days-]hours:]minutes:seconds, rounded to seconds.
export function psOwnsLock(output, lockMtime, now) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d{2})\s+(.+)$/s.exec(output.trim());
  if (!m) return null;
  const seconds = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  return now - seconds * 1000 <= lockMtime + 2000 && COPILOT_ARGS.test(m[5]);
}

// true, false, or null when the process cannot be checked.
async function runsCopilot(pid, dir, lockMtime) {
  if (HAS_PROC) {
    let argv;
    try {
      if ((await stat(`/proc/${pid}`)).uid !== process.getuid()) return false;
      argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    } catch (e) {
      return e.code === 'ENOENT' || e.code === 'ESRCH' ? false : null;
    }
    if (!isCopilotArgv(argv)) return false;
    try {
      return holdsFile(pid, await realpath(join(dir, `inuse.${pid}.hold`)));
    } catch (e) {
      return e.code === 'ENOENT' ? true : null;
    }
  }
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: the process belongs to another user, so it does not run a session of this user.
    return e.code === 'ESRCH' || e.code === 'EPERM' ? false : null;
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=,args=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
      if (err) resolve(err.code === 1 ? false : null);
      else resolve(psOwnsLock(out, lockMtime, Date.now()));
    });
  });
}

// The processes that may be shells of the Copilot process `pid`, with their start times; null
// where /proc cannot list them. Copilot starts each shell in a session of its own, while rg and
// git of its tools stay in its session. Each thread of a process lists the children it forked.
export async function shellProcs(pid) {
  if (!HAS_CHILDREN) return null;
  const tasks = await readdir(`/proc/${pid}/task`).catch(() => null);
  if (!tasks) return null;
  const kids = new Set();
  for (const t of tasks) {
    const text = await readFile(`/proc/${pid}/task/${t}/children`, 'utf8').catch(() => '');
    for (const k of text.split(' ')) if (/^\d+$/.test(k)) kids.add(Number(k));
  }
  const btime = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8').catch(() => ''))?.[1]);
  if (!btime) return null;
  const out = [];
  for (const k of kids) {
    try {
      const stat = await readFile(`/proc/${k}/stat`, 'utf8');
      // The fields after the name in parentheses start at the third: the session is the 6th and
      // starttime the 22nd.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[3]) !== k) continue;
      const ticks = Number(f[19]);
      const argv = (await readFile(`/proc/${k}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (Number.isFinite(ticks) && argv.length) out.push({ pid: k, ticks, start: btime * 1000 + ticks * (1000 / CLOCK_TICKS), argv });
    } catch {
      // The process ended meanwhile.
    }
  }
  return out;
}

// "90m", "24h", "7d"; a bare number means hours.
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[(m[2] || 'h').toLowerCase()];
  const ms = Number(m[1]) * unit;
  return Number.isFinite(ms) ? ms : null;
}

// Reads the top-level scalars of workspace.yaml: plain, quoted, and block scalars.
export function parseWorkspaceYaml(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const more = [];
    while (i + 1 < lines.length && (lines[i + 1] === '' || /^[ \t]/.test(lines[i + 1]))) more.push(lines[++i]);
    while (more.length && !more.at(-1).trim()) more.pop();
    out[m[1]] = scalar((m[2] ?? '').trim(), more);
  }
  return out;
}

function scalar(head, more) {
  const block = /^([|>])(?:([-+])\d*|\d+([-+]?))?$/.exec(head);
  if (block) {
    const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const body = more.map((l) => (l.trim() ? l.slice(indent) : ''));
    const text = block[1] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    return (block[2] ?? block[3]) === '-' ? text : `${text}\n`;
  }
  const flat = [head, ...more.map((l) => l.trim())].join(' ');
  if (flat.startsWith("'")) {
    let s = '';
    for (let i = 1; i < flat.length; i++) {
      if (flat[i] !== "'") s += flat[i];
      else if (flat[i + 1] === "'") s += flat[i++];
      else break;
    }
    return s;
  }
  if (flat.startsWith('"')) {
    const end = flat.lastIndexOf('"');
    try {
      return JSON.parse(flat.slice(0, end + 1));
    } catch {
      return flat.slice(1, end > 0 ? end : undefined);
    }
  }
  return flat.replace(/\s+#.*$/, '');
}

function firstLine(value, max) {
  if (typeof value !== 'string') return null;
  const line = value.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

function keepTail(tail, chunk) {
  if (chunk.length >= TAIL) return Buffer.from(chunk.subarray(chunk.length - TAIL));
  return Buffer.concat([tail, chunk]).subarray(-TAIL);
}

export function createMonitor({
  model, home = copilotHome(), sinceMs = 864e5, pollMs = 750, discoverMs = 5000, chunkSize = 1 << 20,
  now = Date.now, onReady = null, onError = null,
} = {}) {
  const stateDir = join(home, 'session-state');
  const trackers = new Map();
  const locks = new Map();
  const timers = new Set();
  const counts = { bytes: 0, lines: 0, parsed: 0, bad: 0, resets: 0 };
  let stopped = false;
  let ready = false;

  // true, false, or null when the owner cannot be checked. The lock file stays when Copilot is
  // killed, so the PID must still run Copilot.
  async function liveness(sid, dir) {
    let st;
    try {
      st = await stat(dir);
    } catch (e) {
      return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? false : null;
    }
    let c = locks.get(sid);
    if (!c || c.mtime !== st.mtimeMs || now() - c.checkedAt > LOCK_RECHECK_MS) {
      let names;
      try {
        names = await readdir(dir);
      } catch (e) {
        return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? false : null;
      }
      c = { mtime: st.mtimeMs, checkedAt: now(), rejected: c?.rejected, pids: names.map((n) => LOCK_RE.exec(n)?.[1]).filter(Boolean).map(Number) };
      locks.set(sid, c);
    }
    let alive = false;
    for (const pid of c.pids) {
      let lockMtime;
      if (!HAS_PROC) {
        try {
          lockMtime = (await stat(join(dir, `inuse.${pid}.lock`))).mtimeMs;
        } catch (e) {
          if (e.code !== 'ENOENT') alive = null;
          continue;
        }
        if (c.rejected?.get(pid) === lockMtime) continue;
      }
      const v = await runsCopilot(pid, dir, lockMtime);
      if (!HAS_PROC && v === false) (c.rejected ??= new Map()).set(pid, lockMtime);
      if (v === true) {
        c.pid = pid;
        return true;
      }
      if (v === null) alive = null;
    }
    return alive;
  }

  async function readWorkspace(tr) {
    const path = join(tr.dir, 'workspace.yaml');
    let st;
    try {
      st = await stat(path);
    } catch {
      return;
    }
    if (st.mtimeMs === tr.yamlMtime) return;
    try {
      const y = parseWorkspaceYaml(await readFile(path, 'utf8'));
      tr.yamlMtime = st.mtimeMs;
      model.setMeta(tr.sid, { name: firstLine(y.name, 200), client: y.last_client_name || y.client_name || null });
    } catch (e) {
      if (e.code !== 'ENOENT') onError?.(e);
    }
  }

  // A session is shown while Copilot runs it or its log changed within the window.
  async function discover() {
    let entries;
    try {
      entries = await readdir(stateDir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      entries = [];
    }
    const keep = new Set();
    // One Copilot process can run several sessions; its children are read once per pass.
    const procsOf = new Map();
    for (const ent of entries) {
      if (stopped) return;
      if (!ent.isDirectory() || !validSessionId(ent.name)) continue;
      const sid = ent.name;
      const dir = join(stateDir, sid);
      let st;
      try {
        st = await stat(join(dir, 'events.jsonl'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        continue;
      }
      const alive = await liveness(sid, dir);
      if (alive !== true && now() - st.mtimeMs > sinceMs) continue;
      let tr = trackers.get(sid);
      if (!tr) {
        tr = { sid, dir, path: join(dir, 'events.jsonl'), ino: null, goal: null, loaded: false, pos: 0, tail: NO_BYTES, seenMtime: null, rewrittenMtime: null, partial: [], partialLen: 0, skip: false, busy: false, gone: false, yamlMtime: null, mtime: 0, alive: null };
        trackers.set(sid, tr);
      }
      tr.mtime = st.mtimeMs;
      tr.alive = alive;
      keep.add(sid);
      model.setMeta(sid, { alive });
      await readWorkspace(tr);
      // The shells of a log that is still being read may have ended in the part not read yet.
      const pid = alive === true ? locks.get(sid)?.pid : null;
      if (pid != null && !tr.busy && tr.pos >= st.size && model.wantsShellCheck(sid)) {
        if (!procsOf.has(pid)) procsOf.set(pid, await shellProcs(pid));
        const procs = procsOf.get(pid);
        if (procs) model.checkShells(sid, procs, now());
      }
    }
    for (const [sid, tr] of trackers) {
      if (keep.has(sid)) continue;
      tr.gone = true;
      trackers.delete(sid);
      model.removeSession(sid);
    }
    const names = new Set(entries.map((e) => e.name));
    for (const sid of locks.keys()) if (!names.has(sid)) locks.delete(sid);
  }

  function handleLine(tr, line) {
    if (line.length === 0 || (line.length === 1 && line[0] === 13)) return;
    counts.lines++;
    const m = TYPE_RE.exec(line.toString('latin1', 0, Math.min(line.length, 80)));
    if (m && !HANDLED_TYPES.has(m[1])) return;
    let ev;
    try {
      ev = JSON.parse(line.toString('utf8'));
    } catch {
      counts.bad++;
      return;
    }
    if (!m && !HANDLED_TYPES.has(ev?.type)) return;
    counts.parsed++;
    model.ingest(tr.sid, ev);
  }

  function feedBytes(tr, buf) {
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(10, start);
      const end = nl === -1 ? buf.length : nl;
      if (tr.skip) {
        if (nl !== -1) tr.skip = false;
      } else if (nl === -1) {
        tr.partial.push(Buffer.from(buf.subarray(start, end)));
        tr.partialLen += end - start;
        if (tr.partialLen > MAX_LINE) {
          tr.partial = [];
          tr.partialLen = 0;
          tr.skip = true;
          counts.bad++;
        }
      } else {
        let line = buf.subarray(start, end);
        if (tr.partialLen) {
          line = Buffer.concat([...tr.partial, line]);
          tr.partial = [];
          tr.partialLen = 0;
        }
        handleLine(tr, line);
      }
      if (nl === -1) break;
      start = nl + 1;
    }
  }

  async function pump(tr) {
    if (tr.busy || tr.gone || stopped) return;
    tr.busy = true;
    let fh;
    try {
      const st = await stat(tr.path).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
      if (!st || (st.ino === tr.ino && st.size === tr.pos && st.mtimeMs === tr.seenMtime)) return;
      fh = await open(tr.path, 'r');
      const fst = await fh.stat();
      // A replaced, truncated, or rewritten log starts over.
      let reset = tr.ino !== null && (fst.ino !== tr.ino || fst.size < tr.pos || (!tr.loaded && fst.size < tr.goal));
      if (!reset && tr.tail.length) {
        const seen = Buffer.alloc(tr.tail.length);
        const { bytesRead } = await fh.read(seen, 0, seen.length, tr.pos - seen.length);
        reset = bytesRead !== seen.length || !seen.equals(tr.tail);
      }
      // A rewrite to the same size and the same end shows only in the mtime. A write changes the
      // mtime before the size, so the change counts when the next look finds the same mtime.
      if (!reset && tr.ino !== null && fst.size === tr.pos && fst.mtimeMs !== tr.seenMtime) {
        if (tr.rewrittenMtime !== fst.mtimeMs) {
          tr.rewrittenMtime = fst.mtimeMs;
          return;
        }
        reset = true;
      }
      tr.rewrittenMtime = null;
      // discover() may have dropped the session meanwhile.
      if (tr.gone || stopped) return;
      if (reset) {
        model.resetSession(tr.sid);
        counts.resets++;
        Object.assign(tr, { goal: null, loaded: false, pos: 0, tail: NO_BYTES, partial: [], partialLen: 0, skip: false });
      }
      tr.goal ??= fst.size;
      if (tr.goal === 0) tr.loaded = true;
      tr.ino = fst.ino;
      tr.seenMtime = fst.mtimeMs;
      const buf = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(fst.size - tr.pos, 1)));
      while (tr.pos < fst.size && !tr.gone && !stopped) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, fst.size - tr.pos), tr.pos);
        if (!bytesRead || tr.gone || stopped) break;
        const chunk = buf.subarray(0, bytesRead);
        tr.pos += bytesRead;
        tr.tail = keepTail(tr.tail, chunk);
        counts.bytes += bytesRead;
        feedBytes(tr, chunk);
        if (tr.pos >= tr.goal) tr.loaded = true;
        if (tr.pos < fst.size) await yieldNow();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') onError?.(e);
    } finally {
      await fh?.close().catch(() => {});
      tr.busy = false;
    }
  }

  async function pumpAll() {
    for (const tr of [...trackers.values()]) {
      if (stopped) return;
      await pump(tr);
    }
  }

  function every(ms, fn) {
    const run = async () => {
      try {
        await fn();
      } catch (e) {
        onError?.(e);
      }
      if (stopped) return;
      const t = setTimeout(() => {
        timers.delete(t);
        run();
      }, ms);
      timers.add(t);
    };
    return run;
  }

  return {
    // Running sessions load first, then the rest from the newest.
    async start() {
      await discover();
      const order = [...trackers.values()].sort((a, b) => (b.alive === true) - (a.alive === true) || b.mtime - a.mtime);
      for (const tr of order) {
        if (stopped) return;
        await pump(tr);
      }
      ready = true;
      onReady?.();
      every(pollMs, pumpAll)();
      every(discoverMs, discover)();
    },
    // One discovery and read pass, for tests.
    async sync() {
      await discover();
      await pumpAll();
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    loaded: (sid) => trackers.get(sid)?.loaded === true,
    get ready() { return ready; },
    stats: () => ({ ...counts, sessions: trackers.size }),
  };
}
