// The runtime directory, the control socket, and the code version, shared by the CLI and the server.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 7421;
const SERVER_FILES = ['model.mjs', 'monitor.mjs', 'runtime.mjs', 'server.mjs', 'collector.mjs', 'sources.mjs', 'remote.mjs', 'wire.mjs', 'worker.mjs'];
const HAS_PROC = existsSync('/proc/self/stat');

// Only the owner may enter the directory, because the socket hands out pairing codes.
export async function runtimeDir(env = process.env) {
  const uid = process.getuid?.();
  const candidates = [];
  if (env.XDG_RUNTIME_DIR) candidates.push(join(env.XDG_RUNTIME_DIR, 'copilot-viz'));
  candidates.push(join(tmpdir(), `copilot-viz-${uid ?? 'user'}`));
  let error;
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await lstat(dir);
      if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
      if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} belongs to another user`);
      if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
      return dir;
    } catch (e) {
      error = e;
    }
  }
  throw error;
}

export const socketPath = (dir) => join(dir, 'control.sock');

// A zombie has exited and closed its sockets. It stays until its parent collects it, which the
// PID 1 of a container may never do.
export function running(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
  if (!HAS_PROC) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
    return stat[stat.lastIndexOf(')') + 2] !== 'Z';
  } catch {
    return false;
  }
}

// A running server whose code differs from the files on disk is replaced.
export async function codeVersion() {
  const h = createHash('sha256');
  for (const f of SERVER_FILES) h.update(await readFile(join(HERE, f)));
  return h.digest('hex').slice(0, 12);
}

// HTTP over the control socket. Resolves to null when no server listens there.
export function control(sock, method, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          reject(new Error(`unexpected reply from ${sock}: ${body.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error(`the reply from ${sock} ended early`));
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no reply from ${sock}`), { code: 'ETIMEDOUT' })), timeoutMs);
    // The socket keeps the process running while the request is open.
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? resolve(null) : reject(e)));
    req.end();
  });
}
