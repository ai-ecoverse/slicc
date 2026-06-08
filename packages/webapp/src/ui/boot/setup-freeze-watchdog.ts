/**
 * `setup-freeze-watchdog.ts` — main-thread freeze watchdog extracted
 * verbatim from `main.ts`.
 *
 * Spawns a Worker that pings the main thread every 2s. If the main
 * thread doesn't pong within 5s the worker logs a warning. When the
 * main thread recovers it captures a performance timeline and
 * `console.trace()`.
 *
 * Extension CSP blocks `blob:` workers, so this is a no-op in extension
 * mode — the offscreen document is a separate process anyway, so a
 * frozen sprinkle in the panel won't block the agent.
 */

export function startFreezeWatchdog(): void {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return;

  const workerCode = `
    let lastPong = Date.now();
    let frozen = false;
    setInterval(() => {
      postMessage({ type: 'ping' });
      const elapsed = Date.now() - lastPong;
      if (elapsed > 5000 && !frozen) {
        frozen = true;
        postMessage({ type: 'freeze-detected', elapsed });
      }
    }, 2000);
    self.onmessage = (e) => {
      if (e.data.type === 'pong') {
        lastPong = Date.now();
        if (frozen) {
          frozen = false;
          postMessage({ type: 'freeze-recovered' });
        }
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);
  URL.revokeObjectURL(blobUrl);

  worker.onmessage = (e) => {
    if (e.data.type === 'ping') {
      worker.postMessage({ type: 'pong' });
    } else if (e.data.type === 'freeze-detected') {
      console.error(
        `[freeze-watchdog] Main thread blocked for ${e.data.elapsed}ms — capturing trace on recovery`
      );
    } else if (e.data.type === 'freeze-recovered') {
      console.error('[freeze-watchdog] Main thread recovered. Stack trace at recovery point:');
      console.trace('[freeze-watchdog] recovery stack');
      const longTasks = performance.getEntriesByType('longtask');
      if (longTasks.length > 0) {
        console.error(
          '[freeze-watchdog] Long tasks:',
          longTasks.map((t) => ({ duration: t.duration, startTime: t.startTime, name: t.name }))
        );
      }
    }
  };

  window.addEventListener(
    'beforeunload',
    () => {
      worker.terminate();
    },
    { once: true }
  );
}
