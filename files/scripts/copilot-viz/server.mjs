// Serves the dashboard on 127.0.0.1 and streams the model to it as server-sent events.
// The control socket in the owner-only runtime directory hands out single-use pairing codes,
// and the page trades a code for the bearer token that every API request needs. The token
// lives only in this process, so a page of an earlier server must pair again.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { endianness, release } from 'node:os';
import { join } from 'node:path';
import { loadRemotes } from './remote.mjs';
import { createSources } from './sources.mjs';
import { codeVersion, control, DEFAULT_PORT, HERE, runtimeDir, socketPath } from './runtime.mjs';

const PUBLIC = join(HERE, 'public');
const STATIC_RE = /^\/([a-z0-9-]+\.(html|mjs|css|svg))$/;
const TYPES = { html: 'text/html; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
// A name other than these means DNS rebinding or a request that was not meant for us.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const PING_MS = 15_000;
const OWNER_CHECK_MS = 5_000;
const IDLE_CHECK_MS = 30_000;
const CODE_TTL_MS = 120_000;
// A viewer with more unsent bytes than this gets no deltas until it reads them, then a snapshot.
const BACKLOG = 1 << 20;
const STALL_MS = 60_000;
// The localhost relay of WSL connects as root on behalf of Windows programs. With mirrored
// networking, a Windows program connects without a socket on this side.
const WSL = /microsoft/i.test(release());

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(...args);
  });
}

// The server listens on a name of its own and links the socket into place, so it never replaces
// the socket of a running server. Closing the server removes only the name that it listened on,
// so it cannot remove the socket of a server that took over. Returns the inode of the socket.
async function claim(server, sock) {
  const tmp = `${sock}.${process.pid}`;
  await unlink(tmp).catch(() => {});
  await listen(server, tmp);
  try {
    await chmod(tmp, 0o600).catch(() => {});
    // The link shares this inode. Reading it from the socket instead could find the socket of a
    // server that replaced ours right after the link.
    const { ino } = await lstat(tmp);
    for (let tries = 0; ; tries++) {
      try {
        await link(tmp, sock);
        return ino;
      } catch (e) {
        if (e.code !== 'EEXIST' || tries === 2) throw e;
      }
      const old = await lstat(sock).catch(() => null);
      if (old && (await control(sock, 'GET', '/status', 1000).catch(() => true))) {
        throw Object.assign(new Error('another copilot-viz server is running'), { code: 'RUNNING' });
      }
      if (old) await removeStale(sock, old.ino);
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Removes the socket of this inode, where no server answers. Another server may link its socket
// there meanwhile, so the file is moved aside first and linked back when it has another inode.
export async function removeStale(sock, ino) {
  const aside = `${sock}.stale.${process.pid}`;
  try {
    await rename(sock, aside);
  } catch {
    return;
  }
  if ((await lstat(aside).catch(() => null))?.ino !== ino) await link(aside, sock).catch(() => {});
  await unlink(aside).catch(() => {});
}

// /proc/net/tcp and tcp6 print each 32-bit word of an address in host byte order.
function procAddresses(address, port, le) {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address ?? '');
  if (!m || !Number.isInteger(port)) return [];
  const word = (bytes) => (le ? [...bytes].reverse() : bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const v4 = word(m.slice(1).map(Number));
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return [`${v4}:${hexPort}`, `0000000000000000${word([0, 0, 255, 255])}${v4}:${hexPort}`];
}

// The UIDs that own the sockets in /proc/net/tcp and tcp6 whose local end is `from` and whose
// remote end is `to`.
export function socketOwners(tables, from, to, le = endianness() === 'LE') {
  const local = new Set(procAddresses(from.address, from.port, le));
  const remote = new Set(procAddresses(to.address, to.port, le));
  const uids = [];
  for (const table of tables) {
    for (const line of table.split('\n')) {
      // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
      const f = line.trim().split(/\s+/);
      // A socket in TIME_WAIT has no owner left.
      if (f.length > 7 && local.has(f[1]) && remote.has(f[2]) && f[3] !== '06') uids.push(Number(f[7]));
    }
  }
  return uids;
}

// Whether the client end of a connection belongs to `uid`. Each table is the text of
// /proc/net/tcp or tcp6, or the error of reading it.
export function peerVerdict(tables, from, to, { uid, wsl, le = endianness() === 'LE' }) {
  const read = tables.filter((t) => typeof t === 'string');
  // Without a table there is nothing to check.
  if (!read.length) return true;
  const uids = socketOwners(read, from, to, le);
  if (uids.length) return uids.every((u) => u === uid || (wsl && u === 0));
  // No row is found for a Windows program over mirrored networking. A table that could not be
  // read may hold the row, unlike a table that does not exist.
  return wsl && tables.every((t) => typeof t === 'string' || t?.code === 'ENOENT');
}

// What the ping timer does with a viewer: ping it, drop it when it has not caught up for
// STALL_MS, or null to wait. A viewer that skipped a message catches up only on a drain.
export function pingAction(c, unsent, now) {
  if (!c.stale && unsent <= BACKLOG) return 'ping';
  return now - c.caughtUp > STALL_MS ? 'drop' : null;
}

async function bindTcp(server, port) {
  try {
    await listen(server, port, '127.0.0.1');
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || port === 0) throw e;
    await listen(server, 0, '127.0.0.1');
  }
  return server.address().port;
}

function hostname(header) {
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(String(header ?? '').trim().toLowerCase());
  return m ? m[1] : '';
}

function sameToken(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const frame = (msg) => `data: ${JSON.stringify(msg)}\n\n`;

export async function startServer({
  port = DEFAULT_PORT, sinceMs = 864e5, idleExitMs = 0, remotePauseMs = 600_000, log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const remotes = await loadRemotes();
  const dir = await runtimeDir();
  const sock = socketPath(dir);
  const version = await codeVersion();
  const startedAt = Date.now();
  const uid = process.getuid?.();
  const token = randomBytes(32).toString('base64url');
  const codes = new Map();
  // Each viewer: whether it skipped a message and so needs a snapshot, when it last caught up,
  // and whether its page is in view, as the page last reported.
  const clients = new Map();
  // The ID that the first message of a stream gives its page, so a report of an earlier stream
  // of the same page does not count for this one.
  const viewers = new Map();
  const peers = new WeakMap();
  const timers = [];
  let idleSince = startedAt;
  let pauseTimer = null;
  let remotesPaused = false;
  let actualPort = null;
  let ownIno = null;
  let closing = false;
  let errors = 0;

  const report = (what, err) => {
    if (++errors <= 20) log(`copilot-viz: ${what}: ${err?.stack ?? err}`);
    else if (errors === 21) log('copilot-viz: more errors follow; only the count is kept');
  };
  const sources = createSources({
    remotes, sinceMs, onMessage: broadcast,
    onError: (err) => report('collecting sessions', err),
  });

  const status = () => ({
    pid: process.pid, version, startedAt, requestedPort: port, port: actualPort, url: actualPort ? `http://127.0.0.1:${actualPort}/` : null,
    ready: sources.snapshot().ready, sinceMs, idleExitMs, remotePauseMs, remotesPaused, clients: clients.size,
    visibleClients: [...clients.values()].filter((c) => c.visible).length,
    sessions: sources.snapshot().sessions.length, hosts: sources.snapshot().hosts, remotes, errors,
  });
  const snapshot = () => sources.snapshot();

  // SSH to the remote hosts closes once no page has been in view for remotePauseMs, and opens
  // again as soon as one is.
  function watchViewers() {
    if (closing) return;
    if ([...clients.values()].some((c) => c.visible)) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
      if (!remotesPaused) return;
      remotesPaused = false;
      log('copilot-viz: a page is in view; connecting the remote hosts');
      sources.resume();
    } else if (!remotesPaused && !pauseTimer && remotes.length && remotePauseMs > 0) {
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        remotesPaused = true;
        log(`copilot-viz: no page in view for ${remotePauseMs / 60_000} minutes; disconnecting the remote hosts`);
        sources.pause();
      }, remotePauseMs);
    }
  }

  function newCode() {
    const now = Date.now();
    for (const [c, expires] of codes) if (expires < now) codes.delete(c);
    const code = randomBytes(18).toString('base64url');
    codes.set(code, now + CODE_TTL_MS);
    return code;
  }
  const launchUrl = () => `http://127.0.0.1:${actualPort}/?code=${newCode()}`;

  function onControl(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/status') return send(200, status());
    if (req.method === 'POST' && url.pathname === '/launch') {
      // The link of a server that is stopping would not work.
      if (closing) return send(503, { error: 'stopping' });
      return actualPort ? send(200, { ...status(), launch: launchUrl() }) : send(503, { error: 'starting' });
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      // The caller names the server it saw, so it does not stop one that replaced it.
      const pid = url.searchParams.get('pid');
      if (pid !== null && Number(pid) !== process.pid) return send(409, { error: 'another server', pid: process.pid });
      send(200, { ok: true });
      // At once, so that no request after this one gets a link. The control socket closes only
      // after this reply is sent.
      shutdown('stop requested');
      return undefined;
    }
    return send(404, { error: 'not found' });
  }

  // Another user of this machine can connect to 127.0.0.1 too. On Linux, the socket table tells
  // whose program holds the other end.
  function peerAllowed(socket) {
    if (process.platform !== 'linux' || uid === undefined) return true;
    let allowed = peers.get(socket);
    if (allowed === undefined) {
      allowed = Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'latin1').catch((e) => e))).then((tables) => peerVerdict(
        tables,
        { address: socket.remoteAddress, port: socket.remotePort },
        { address: socket.localAddress, port: socket.localPort },
        { uid, wsl: WSL },
      ));
      peers.set(socket, allowed);
    }
    return allowed;
  }

  function send(res, c, chunk) {
    if (c.stale || res.writableLength > BACKLOG) {
      c.stale = true;
      return;
    }
    res.write(chunk);
  }
  function broadcast(msg) {
    if (!clients.size) return;
    const chunk = frame(msg);
    for (const [res, c] of clients) send(res, c, chunk);
  }
  async function serveFile(req, res, name, ext) {
    let body;
    try {
      body = await readFile(join(PUBLIC, name));
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[ext], 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function pair(req, res) {
    let origin = null;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      // Checked below.
    }
    if (origin?.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) return json(res, 403, { error: 'bad origin' });
    let code;
    try {
      code = JSON.parse(await readBody(req, 1024)).code;
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    const expires = typeof code === 'string' ? codes.get(code) : undefined;
    if (expires === undefined) return json(res, 403, { error: 'unknown or used code' });
    codes.delete(code);
    if (expires < Date.now()) return json(res, 403, { error: 'expired code' });
    return json(res, 200, { token });
  }

  // EventSource cannot send headers, so the stream takes the token from the query.
  function stream(req, res, given) {
    if (!sameToken(given, token)) return json(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    req.socket.setNoDelay(true);
    // Not in view until the page says so, so that a hidden tab that reconnects does not open SSH.
    const c = { stale: false, caughtUp: Date.now(), id: randomBytes(12).toString('base64url'), visible: false, seq: -1 };
    res.write(`retry: 3000\n\n${frame({ ...snapshot(), viewer: c.id })}`);
    clients.set(res, c);
    viewers.set(c.id, c);
    // A delta carries only the sessions that changed, so a viewer that skipped one needs everything.
    res.on('drain', () => {
      c.caughtUp = Date.now();
      if (!c.stale) return;
      c.stale = false;
      res.write(frame(snapshot()));
    });
    res.on('close', () => {
      clients.delete(res);
      viewers.delete(c.id);
      if (!clients.size) idleSince = Date.now();
      watchViewers();
    });
    watchViewers();
    return undefined;
  }

  // Reports may arrive out of order, so the newest by the page's count wins.
  async function reportView(req, res) {
    if (!bearer(req)) return json(res, 401, { error: 'unauthorized' });
    let body;
    try {
      body = JSON.parse(await readBody(req, 256));
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    if (typeof body?.viewer !== 'string' || typeof body.visible !== 'boolean' || !Number.isSafeInteger(body.seq)) {
      return json(res, 400, { error: 'bad request' });
    }
    const c = viewers.get(body.viewer);
    if (!c) return json(res, 404, { error: 'no such stream' });
    if (body.seq > c.seq) {
      c.seq = body.seq;
      c.visible = body.visible;
      watchViewers();
    }
    return json(res, 200, { ok: true });
  }

  const bearer = (req) => sameToken(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1], token);

  async function onRequest(req, res) {
    try {
      if (!LOCAL_HOSTS.has(hostname(req.headers.host))) return json(res, 403, { error: 'forbidden host' });
      if (!(await peerAllowed(req.socket))) return json(res, 403, { error: 'forbidden user' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === '/') return await serveFile(req, res, 'index.html', 'html');
        const m = STATIC_RE.exec(path);
        if (m) return await serveFile(req, res, m[1], m[2]);
      }
      if (path === '/api/pair' && req.method === 'POST') return await pair(req, res);
      if (path === '/api/stream' && req.method === 'GET') return stream(req, res, url.searchParams.get('token'));
      if (path === '/api/view' && req.method === 'POST') return await reportView(req, res);
      if (path === '/api/state' && req.method === 'GET') {
        if (!bearer(req)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, snapshot());
      }
      if (path === '/api/call' && req.method === 'GET') {
        if (!bearer(req)) return json(res, 401, { error: 'unauthorized' });
        const sid = url.searchParams.get('sid') ?? '';
        const id = url.searchParams.get('id') ?? '';
        const epoch = url.searchParams.get('epoch') ?? undefined;
        if (sid.length > 330 || id.length > 200 || (epoch !== undefined && epoch.length > 220)) return json(res, 400, { error: 'invalid call reference' });
        const detail = await sources.callDetail(sid, id, epoch);
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e.status === 409 || e.status === 503) return json(res, e.status, { error: e.message });
      // The query may hold the token or a pairing code.
      report(`${req.method} ${(req.url ?? '').split('?')[0]}`, e);
      if (!res.headersSent) return json(res, 500, { error: 'internal error' });
      return res.destroy();
    }
  }

  const ctl = createServer(onControl);
  const http = createServer(onRequest);
  http.on('clientError', (err, socket) => socket.destroy());
  try {
    ownIno = await claim(ctl, sock);
  } catch (e) {
    ctl.close();
    throw e;
  }
  async function unclaim() {
    if (ownIno !== null && (await lstat(sock).catch(() => null))?.ino === ownIno) await unlink(sock).catch(() => {});
  }
  try {
    actualPort = await bindTcp(http, port);
  } catch (e) {
    await unclaim();
    ctl.close();
    throw e;
  }

  function shutdown(reason) {
    if (closing) return;
    closing = true;
    log(`copilot-viz: stopping: ${reason}`);
    clearTimeout(pauseTimer);
    const stopped = sources.stop();
    for (const t of timers) clearInterval(t);
    for (const res of clients.keys()) res.end();
    if (http.listening) {
      http.closeAllConnections();
      http.close();
    }
    Promise.all([stopped, unclaim(), new Promise((resolve) => ctl.close(resolve))]).then(
      () => process.exit(0),
      (e) => { report('stopping sources', e); process.exit(1); },
    );
  }

  // A viewer that has not caught up for a minute is dropped; EventSource reconnects and gets a
  // snapshot.
  timers.push(setInterval(() => {
    const now = Date.now();
    for (const [res, c] of clients) {
      const action = pingAction(c, res.writableLength, now);
      if (action === 'ping') {
        c.caughtUp = now;
        res.write(': ping\n\n');
      } else if (action === 'drop') {
        res.destroy();
      }
    }
  }, PING_MS));
  timers.push(setInterval(async () => {
    if ((await lstat(sock).catch(() => null))?.ino !== ownIno) shutdown('the control socket was removed or replaced');
  }, OWNER_CHECK_MS));
  if (idleExitMs > 0) {
    timers.push(setInterval(() => {
      const now = Date.now();
      if (clients.size || now - idleSince < idleExitMs) return;
      for (const expires of codes.values()) if (expires > now) return;
      shutdown(`no viewer for ${Math.round(idleExitMs / 60_000)} minutes`);
    }, IDLE_CHECK_MS));
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig));

  log(`copilot-viz: serving http://127.0.0.1:${actualPort}/ (pid ${process.pid}, control ${sock})`);
  sources.start();
  watchViewers();
  return { port: actualPort, sock, launchUrl, shutdown };
}
