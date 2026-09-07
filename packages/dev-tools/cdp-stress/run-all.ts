/**
 * Run every scenario and write <out>/<timestamp>.json + <out>/latest.json.
 * Usage: npx tsx packages/dev-tools/cdp-stress/run-all.ts [--quick]
 *
 * Output goes to `dist/cdp-stress/` (gitignored) unless HARNESS_OUT is set.
 * This is the exploration entry point; the assertions that gate the fix live
 * in packages/webapp/tests/cdp/cdp-stress.gate.test.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Keeps the node-policy stale run under a minute (production default is 30s).
process.env['HARNESS_CDP_TIMEOUT_MS'] ??= '8000';

const quick = process.argv.includes('--quick');
const outDir =
  process.env['HARNESS_OUT'] ?? resolve(import.meta.dirname, '../../../dist/cdp-stress');
/** One scenario's `run()` result, or the error that stopped it. */
type StepOutcome = unknown | { crashed: string };
interface RunAllResults {
  startedAt: string;
  finishedAt?: string;
  quick: boolean;
  steps: Record<string, StepOutcome>;
}
const results: RunAllResults = { startedAt: new Date().toISOString(), quick, steps: {} };

const step = async (name: string, fn: () => Promise<unknown>) => {
  const t0 = Date.now();
  process.stderr.write(`▶ ${name}\n`);
  try {
    results.steps[name] = await fn();
  } catch (e) {
    results.steps[name] = { crashed: e instanceof Error ? e.message : String(e) };
  }
  process.stderr.write(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
};

await step('sessionLeak', async () =>
  (await import('./scenarios/session-leak.js')).run({ tabs: 4, rounds: quick ? 10 : 25 })
);
await step('loadBleed', async () => (await import('./scenarios/load-bleed.js')).run());
await step('staleProxy', async () => (await import('./scenarios/stale-proxy.js')).run());
await step('staleWorkerHop', async () => (await import('./scenarios/stale-worker-hop.js')).run());
await step('abandoned', async () => (await import('./scenarios/abandoned.js')).run());
for (const drivers of quick ? [1, 8] : [1, 4, 8]) {
  await step(`fanout_${drivers}`, async () =>
    (await import('./scenarios/fanout.js')).run({ drivers, iterations: quick ? 4 : 8 })
  );
}
if (!quick) {
  await step('fanout_4_poison', async () =>
    (await import('./scenarios/fanout.js')).run({ drivers: 4, iterations: 4, poison: true })
  );
}

results.finishedAt = new Date().toISOString();
mkdirSync(outDir, { recursive: true });
const stamp = results.startedAt.replace(/[:.]/g, '-');
const json = JSON.stringify(results, null, 2);
writeFileSync(join(outDir, `${stamp}.json`), json);
writeFileSync(join(outDir, 'latest.json'), json);
process.stderr.write(`wrote ${join(outDir, 'latest.json')}\n`);
process.exit(0);
