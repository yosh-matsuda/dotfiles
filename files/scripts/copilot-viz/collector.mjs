import { homedir } from 'node:os';
import { createModel } from './model.mjs';
import { copilotHome, createMonitor } from './monitor.mjs';

export function createCollector({ home = copilotHome(), sinceMs = 864e5, onMessage, onError, canFlush = () => true }) {
  const model = createModel({ home: homedir(), onError });
  let stopped = false;
  let readyOwed = false;
  const timers = [];
  const monitor = createMonitor({
    model, home, sinceMs, onError,
    onReady: () => { readyOwed = true; flush(); },
  });
  function flush() {
    try {
      if (stopped || !canFlush()) return;
      const d = model.drain(monitor.loaded);
      if (d) onMessage({ type: 'delta', now: Date.now(), ready: monitor.ready, ...d });
      else if (readyOwed) onMessage({ type: 'status', ready: true, now: Date.now() });
      readyOwed = false;
    } catch (e) {
      onError?.(e);
    }
  }
  function stop() {
    stopped = true;
    monitor.stop();
    for (const t of timers) clearInterval(t);
  }
  return {
    async start() {
      timers.push(setInterval(flush, 450), setInterval(() => model.tick(), 5000));
      try {
        await monitor.start();
      } catch (e) {
        stop();
        throw e;
      }
    },
    stop, flush,
    snapshot: () => ({ type: 'snapshot', now: Date.now(), ready: monitor.ready, ...model.snapshot(monitor.loaded) }),
    callDetail: (sid, id, epoch) => model.callDetail(sid, id, epoch),
  };
}
