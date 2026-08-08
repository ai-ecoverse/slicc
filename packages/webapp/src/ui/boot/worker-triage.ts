/**
 * `worker-triage.ts` — cheap browser-side self-triage for kernel-ready
 * boot timeouts (#1982).
 *
 * A Chrome session can wedge its browser-process plumbing for http(s)
 * module-worker MAIN-SCRIPT loads: `new Worker('/assets/x.js',
 * {type:'module'})` then never starts — no message, no error — while
 * blob workers, worker-context fetches, and imports from blob workers
 * all keep working (observed in production on Chrome 151, 2026-08-07).
 * In that state the kernel worker can never boot, the recovery screen's
 * "Reset local data & reload" destroys the (intact) VFS + history
 * without fixing anything, and only a full browser restart helps.
 *
 * Two probes tell the situations apart:
 *  1. blob classic worker — proves worker infrastructure works at all.
 *  2. network module worker (`/worker-probe.js`, an un-hashed static
 *     file) — reproduces the exact shape that wedges. ANY signal
 *     (message or error) within the window means the load path is fine;
 *     the wedge's signature is silence.
 */

export type WorkerTriageVerdict = 'browser-wedged' | 'workers-ok' | 'inconclusive';

/** Structural subset of `Worker` used by the probes, for test fakes. */
export interface ProbeWorker {
  addEventListener(type: 'message' | 'error', listener: () => void): void;
  terminate(): void;
}

export interface WorkerTriageDeps {
  /** Spawn the blob classic-worker probe. Defaults to a real `Worker`. */
  spawnBlobWorker?: () => ProbeWorker;
  /** Spawn the network module-worker probe. Defaults to `/worker-probe.js`. */
  spawnModuleWorker?: () => ProbeWorker;
  /** Per-probe silence window. */
  timeoutMs?: number;
}

/**
 * Silence window per probe. The wedge never resolves, so anything beyond
 * "comfortably slower than a same-origin 20-byte script fetch" only
 * delays the improved recovery message.
 */
const PROBE_TIMEOUT_MS = 3000;

type ProbeResult = 'signal' | 'silent' | 'spawn-failed';

function runProbe(spawn: () => ProbeWorker, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let worker: ProbeWorker;
    try {
      worker = spawn();
    } catch {
      resolve('spawn-failed');
      return;
    }
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* probe cleanup is best-effort */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish('silent'), timeoutMs);
    // An 'error' still counts as a signal: the worker got far enough to
    // fetch/parse its script. The wedge's signature is total silence.
    worker.addEventListener('message', () => finish('signal'));
    worker.addEventListener('error', () => finish('signal'));
  });
}

function defaultBlobWorker(): ProbeWorker {
  const blob = new Blob(['self.postMessage(1)'], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    // The main-script fetch resolves against the live object URL at
    // construction; revoking immediately after is safe and leak-free.
    URL.revokeObjectURL(url);
  }
}

function defaultModuleWorker(): ProbeWorker {
  return new Worker('/worker-probe.js', { type: 'module' });
}

/**
 * Classify the browser's worker health. `browser-wedged` — blob workers
 * run but a network module worker stays silent: restarting the browser
 * is the fix and wiping local data is not. `workers-ok` — the network
 * module worker signalled, so the boot failure lies elsewhere.
 * `inconclusive` — anything else (both silent, spawn failures): no
 * claim, keep the default recovery UI.
 */
export async function triageModuleWorkerHealth(
  deps: WorkerTriageDeps = {}
): Promise<WorkerTriageVerdict> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [blobResult, moduleResult] = await Promise.all([
    runProbe(deps.spawnBlobWorker ?? defaultBlobWorker, timeoutMs),
    runProbe(deps.spawnModuleWorker ?? defaultModuleWorker, timeoutMs),
  ]);
  if (blobResult === 'signal' && moduleResult === 'silent') return 'browser-wedged';
  if (moduleResult === 'signal') return 'workers-ok';
  return 'inconclusive';
}
