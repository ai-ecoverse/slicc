/**
 * Spike 1 — DedicatedWorker entry.
 *
 * Receives a `run` message, runs the spike suite, and posts the result
 * back. The page-side `main.ts` is the only sender; protocol is one-shot.
 *
 * THIS IS THROWAWAY CODE.
 */

import { runSpike, type SuiteResult } from './runner.js';

interface RunMsg {
  type: 'run';
  cloneUrl?: string;
  corsProxy?: string;
}

self.addEventListener('message', async (ev: MessageEvent<RunMsg>) => {
  if (ev.data?.type !== 'run') return;
  try {
    const result: SuiteResult = await runSpike({
      context: 'worker',
      opfsSubdir: 'spike1-worker',
      cloneUrl: ev.data.cloneUrl,
      corsProxy: ev.data.corsProxy,
    });
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'result', result });
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: 'result',
      result: {
        context: 'worker',
        backend: 'zenfs+WebAccess(OPFS)',
        setupMs: 0,
        ops: [],
        git: [],
        fatal: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      } satisfies SuiteResult,
    });
  }
});

// Signal readiness so the page knows when the worker module finished
// loading (ZenFS + isomorphic-git bundle is multi-MB in dev).
(self as DedicatedWorkerGlobalScope).postMessage({ type: 'ready' });
