/**
 * Spike 1 — page entry.
 *
 * Renders a tiny status table, runs the suite in the page, then spawns
 * a DedicatedWorker that runs the same suite, and renders both result
 * sets side by side. Findings are also dumped to `window.__spike1Result`
 * so an external driver (CDP / curl /window.fetch) can pick them up.
 *
 * THIS IS THROWAWAY CODE.
 */

import type { OpResult } from './ops.js';
import { runSpike, type SuiteResult } from './runner.js';

const root = document.getElementById('app')!;

function fmtRow(r: OpResult): string {
  const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️';
  const ms = r.ms != null ? `${r.ms}ms` : '';
  const detail = r.detail ? ` — ${r.detail}` : '';
  return `${icon} ${r.op} ${ms}${detail}`;
}

function renderColumn(title: string, suite: SuiteResult): string {
  if (suite.fatal) {
    return `<h2>${title}</h2><pre style="color:#c00">FATAL: ${suite.fatal}</pre>`;
  }
  const opLines = suite.ops.map(fmtRow).join('\n');
  const gitLines = suite.git.map(fmtRow).join('\n');
  return `<h2>${title}</h2>
<p><small>backend=${suite.backend} setupMs=${suite.setupMs}</small></p>
<h3>Ops suite</h3>
<pre>${opLines}</pre>
<h3>isomorphic-git smoke</h3>
<pre>${gitLines}</pre>`;
}

async function runWorkerSuite(opts: {
  cloneUrl?: string;
  corsProxy?: string;
}): Promise<SuiteResult> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise<SuiteResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker timed out after 120s'));
    }, 120_000);
    worker.addEventListener('message', (ev: MessageEvent) => {
      if (ev.data?.type === 'result') {
        clearTimeout(timeout);
        worker.terminate();
        resolve(ev.data.result as SuiteResult);
      }
    });
    worker.addEventListener('error', (ev) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(`worker error: ${ev.message}`));
    });
    worker.postMessage({ type: 'run', cloneUrl: opts.cloneUrl, corsProxy: opts.corsProxy });
  });
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Default to a small repo + the isomorphic-git public CORS proxy. Pass
  // `?clone=0` to skip the network step in CI / offline.
  const wantsClone = params.get('clone') !== '0';
  const cloneUrl = wantsClone
    ? (params.get('cloneUrl') ?? 'https://github.com/isomorphic-git/cors-proxy.git')
    : undefined;
  const corsProxy = wantsClone
    ? (params.get('corsProxy') ?? 'https://cors.isomorphic-git.org')
    : undefined;

  root.innerHTML = '<h1>Spike 1 — OPFS + ZenFS prototype</h1><p>Running page suite…</p>';

  let pageResult: SuiteResult;
  try {
    pageResult = await runSpike({
      context: 'page',
      opfsSubdir: 'spike1-page',
      cloneUrl,
      corsProxy,
    });
  } catch (err) {
    pageResult = {
      context: 'page',
      backend: 'zenfs+WebAccess(OPFS)',
      setupMs: 0,
      ops: [],
      git: [],
      fatal: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  root.innerHTML = `<h1>Spike 1 — OPFS + ZenFS prototype</h1>
<p>Page suite done — running worker suite…</p>
${renderColumn('Page (window) context', pageResult)}`;

  let workerResult: SuiteResult;
  try {
    workerResult = await runWorkerSuite({ cloneUrl, corsProxy });
  } catch (err) {
    workerResult = {
      context: 'worker',
      backend: 'zenfs+WebAccess(OPFS)',
      setupMs: 0,
      ops: [],
      git: [],
      fatal: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }

  root.innerHTML = `<h1>Spike 1 — OPFS + ZenFS prototype</h1>
<p>Done. (Findings also at <code>window.__spike1Result</code>.)</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;font-family:monospace">
  <div>${renderColumn('Page (window) context', pageResult)}</div>
  <div>${renderColumn('DedicatedWorker context', workerResult)}</div>
</div>`;

  // Make results pickup-able from CDP.
  (window as unknown as { __spike1Result: unknown }).__spike1Result = {
    page: pageResult,
    worker: workerResult,
    ts: new Date().toISOString(),
  };
  document.title = 'Spike 1 — done';
}

main().catch((err) => {
  root.innerHTML = `<h1>Spike 1 — fatal error</h1><pre>${
    err instanceof Error ? err.stack : String(err)
  }</pre>`;
});
