export type WorkerTriageVerdict = 'browser-wedged' | 'workers-ok' | 'inconclusive';

export interface ProbeWorker {
  addEventListener(type: 'message' | 'error', listener: () => void): void;
  terminate(): void;
}

export interface WorkerTriageDeps {
  spawnBlobWorker?: () => ProbeWorker;

  spawnModuleWorker?: () => ProbeWorker;

  fetchProbeScript?: (timeoutMs: number) => Promise<boolean>;

  timeoutMs?: number;
}

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
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish('silent'), timeoutMs);

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
    URL.revokeObjectURL(url);
  }
}

function defaultModuleWorker(): ProbeWorker {
  return new Worker('/worker-probe.js', { type: 'module' });
}

async function defaultFetchProbeScript(timeoutMs: number): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch('/worker-probe.js', { cache: 'no-store', signal: abort.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function triageModuleWorkerHealth(
  deps: WorkerTriageDeps = {}
): Promise<WorkerTriageVerdict> {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [blobResult, moduleResult, scriptFetchable] = await Promise.all([
    runProbe(deps.spawnBlobWorker ?? defaultBlobWorker, timeoutMs),
    runProbe(deps.spawnModuleWorker ?? defaultModuleWorker, timeoutMs),
    (deps.fetchProbeScript ?? defaultFetchProbeScript)(timeoutMs),
  ]);
  if (blobResult === 'signal' && moduleResult === 'silent' && scriptFetchable) {
    return 'browser-wedged';
  }
  if (moduleResult === 'signal') return 'workers-ok';
  return 'inconclusive';
}
