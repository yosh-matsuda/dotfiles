import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
    closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function commandLabel(info) {
    const processes = info.foreground_processes ?? [];
    const foreground = processes.find(process => process.pid === info.foreground_process_group_id)
        ?? [...processes].sort((first, second) => first.pid - second.pid)[0];
    if (!foreground) return null;
    const argv = foreground.argv ?? [];
    let command = basename(argv[0] || foreground.argv0 || foreground.name);
    if (['node', 'nodejs', 'bun'].includes(command)) {
        const script = argv[1] ?? '';
        if (/^(copilot|copilot\.[cm]?js)$/.test(basename(script))
            || /(?:^|\/)@github\/copilot\/(?:index|cli)\.[cm]?js$/.test(script)) {
            command = 'copilot';
        }
    }
    return Array.from(command
        .replace(/^-+/, '').replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, 60).join('') || null;
}

export async function updateTabNames(request, managed) {
    const { snapshot } = await request('session.snapshot');
    const tabs = new Set(snapshot.tabs.map(tab => tab.tab_id));
    for (const tabId of Object.keys(managed)) {
        if (!tabs.has(tabId)) delete managed[tabId];
    }

    for (const tab of snapshot.tabs) {
        const ownership = managed[tab.tab_id];
        if (ownership?.disabled) continue;
        if (ownership && ownership.label !== tab.label) {
            managed[tab.tab_id] = { disabled: true };
            continue;
        }
        if (!ownership && tab.label !== String(tab.number)) continue;
        const layout = snapshot.layouts.find(layout => layout.tab_id === tab.tab_id);
        if (!layout) continue;
        const { process_info: info } = await request('pane.process_info', {
            pane_id: layout.focused_pane_id,
        });
        const label = commandLabel(info);
        if (!label || label === tab.label) continue;

        const { snapshot: current } = await request('session.snapshot');
        const currentTab = current.tabs.find(candidate => candidate.tab_id === tab.tab_id);
        const currentLayout = current.layouts.find(candidate => candidate.tab_id === tab.tab_id);
        if (currentTab?.label !== tab.label
            || currentLayout?.focused_pane_id !== layout.focused_pane_id) continue;
        await request('tab.rename', { tab_id: tab.tab_id, label });
        managed[tab.tab_id] = { label };
    }
}

async function connectApi(socketPath, onEvent = () => { }) {
    const socket = createConnection(socketPath);
    await once(socket, 'connect');
    const pending = new Map();
    let sequence = 0;
    const lines = createInterface({ input: socket });
    const fail = error => {
        for (const { reject, timeout } of pending.values()) {
            clearTimeout(timeout);
            reject(error);
        }
        pending.clear();
    };
    socket.on('error', fail);
    lines.on('error', fail);
    socket.on('close', () => fail(new Error('Herdr API connection closed')));
    lines.on('line', line => {
        try {
            const message = JSON.parse(line);
            if (message.event) {
                onEvent(message);
                return;
            }
            const waiting = pending.get(message.id);
            if (!waiting) return;
            pending.delete(message.id);
            clearTimeout(waiting.timeout);
            if (message.error) {
                waiting.reject(Object.assign(new Error(message.error.code ?? 'Herdr API error'), {
                    apiError: true,
                }));
            } else waiting.resolve(message.result);
        } catch (error) {
            fail(error);
            socket.destroy();
        }
    });
    return {
        request(method, params = {}) {
            return new Promise((resolve, reject) => {
                if (socket.destroyed) {
                    reject(new Error('Herdr API connection closed'));
                    return;
                }
                const id = `dotfiles-tab-names:${++sequence}`;
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Herdr API timeout: ${method}`));
                }, 3000);
                pending.set(id, { resolve, reject, timeout });
                socket.write(`${JSON.stringify({ id, method, params })}\n`);
            });
        },
        close() {
            lines.close();
            socket.destroy();
        },
    };
}

function acquireLock(lockPath) {
    try {
        const descriptor = openSync(lockPath, 'wx', 0o600);
        writeFileSync(descriptor, String(process.pid));
        closeSync(descriptor);
        return true;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let pid;
        try {
            pid = Number(readFileSync(lockPath, 'utf8'));
        } catch (readError) {
            if (readError.code === 'ENOENT') return acquireLock(lockPath);
            throw readError;
        }
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return false;
        } catch (probeError) {
            if (probeError.code !== 'ESRCH') return false;
        }
        try {
            unlinkSync(lockPath);
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
        return acquireLock(lockPath);
    }
}

async function watchSession(socketPath, managed, save) {
    let events;
    const connections = new Set();
    const request = async (method, params) => {
        const connection = await connectApi(socketPath);
        connections.add(connection);
        try {
            return await connection.request(method, params);
        } finally {
            connections.delete(connection);
            connection.close();
        }
    };
    let timer;
    let interval;
    let running = false;
    let dirty = false;
    let stopped = false;
    let failures = 0;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        clearInterval(interval);
        finish();
    };
    const refresh = async () => {
        timer = undefined;
        if (stopped) return;
        if (running) {
            dirty = true;
            return;
        }
        running = true;
        try {
            await updateTabNames(request, managed);
            save();
            failures = 0;
        } catch (error) {
            failures += 1;
            if (!error.apiError || failures >= 3) {
                console.error(`herdr-tab-names: ${error.message}`);
                stop();
            }
        } finally {
            running = false;
            if (dirty && !stopped) {
                dirty = false;
                schedule();
            }
        }
    };
    const schedule = () => {
        if (!timer && !stopped) timer = setTimeout(refresh, 80);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
        events = await connectApi(socketPath, schedule);
        await events.request('events.subscribe', {
            subscriptions: ['pane.updated', 'pane.focused', 'tab.focused', 'tab.created', 'tab.closed']
                .map(type => ({ type })),
        });
        interval = setInterval(schedule, 1000);
        schedule();
        await done;
    } finally {
        stop();
        for (const connection of connections) connection.close();
        events?.close();
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
    }
}

async function main() {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (process.env.HERDR_ENV !== '1' || !socketPath) return;
    const key = createHash('sha256').update(resolve(socketPath)).digest('hex').slice(0, 24);
    const directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'),
        'herdr-tab-names', key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.argv.includes('--start')) {
        const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
            detached: true, stdio: ['ignore', 'ignore', log],
        });
        child.on('error', error => console.error(`herdr-tab-names: ${error.message}`));
        child.unref();
        closeSync(log);
        return;
    }
    const lock = join(directory, 'worker.pid');
    if (!acquireLock(lock)) return;
    const statePath = join(directory, 'tabs.json');
    try {
        let managed = {};
        try {
            managed = JSON.parse(readFileSync(statePath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        let saved = JSON.stringify(managed);
        await watchSession(socketPath, managed, () => {
            const next = JSON.stringify(managed);
            if (next === saved) return;
            writeFileSync(`${statePath}.tmp`, next, { mode: 0o600 });
            renameSync(`${statePath}.tmp`, statePath);
            saved = next;
        });
    } finally {
        unlinkSync(lock);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main().catch(error => {
        console.error(`herdr-tab-names: ${error.message}`);
        process.exitCode = 1;
    });
}
