import { homedir } from 'node:os';
import { createModel } from './model.mjs';
import { copilotHome, createMonitor } from './monitor.mjs';

export function createCollector({ home = copilotHome(), sinceMs = 864e5, onMessage, onError }) {
  const model = createModel({ home: homedir(), onError });
  let stopped = false;
  const timers = [];
  const monitor = createMonitor({
    model, home, sinceMs, onError,
    onReady: () => {
      if (!stopped && !flush()) onMessage({ type: 'status', ready: true, now: Date.now() });
    },
  });
  function flush() {
    if (stopped) return false;
    const d = model.drain();
    if (d) onMessage({ type: 'delta', now: Date.now(), ready: monitor.ready, ...d });
    return Boolean(d);
  }
  return {
    async start() {
      timers.push(setInterval(flush, 450), setInterval(() => model.tick(), 5000));
      await monitor.start();
    },
    stop() {
      stopped = true;
      monitor.stop();
      for (const t of timers) clearInterval(t);
    },
    snapshot: () => ({ type: 'snapshot', now: Date.now(), ready: monitor.ready, ...model.snapshot() }),
    callDetail: (sid, id, epoch) => model.callDetail(sid, id, epoch),
  };
}
