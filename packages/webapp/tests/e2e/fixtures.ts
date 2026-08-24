/**
 * The E2E suite's `test` object. Import `{ expect, test }` from here, never
 * from `@playwright/test` directly — the difference is one auto fixture that
 * contains a mid-suite `wrangler dev` crash (#2372).
 *
 * Before and after every spec it checks that the leader origin still answers.
 * A dead origin restarts workerd through the supervisor and fails the current
 * spec with a `WRANGLER_CRASHED`-named error, instead of letting the remaining
 * specs bleed out with `ERR_CONNECTION_REFUSED`. The post-test half attributes
 * the crash to the spec that was running when workerd went down.
 */
import { test as base, expect } from '@playwright/test';
import {
  assertLeaderAlive,
  createLeaderHealthState,
  type LeaderHealthDeps,
} from './leader-health.js';
import { LEADER_ORIGIN, WRANGLER_SUPERVISOR_ORIGIN } from './playwright.config.js';

export { WRANGLER_CRASHED, WranglerCrashedError } from './leader-health.js';
export { expect };

function healthDeps(origin: string): LeaderHealthDeps {
  return {
    // `/status` runs the worker's own `fetch` handler (assets are configured
    // `run_worker_first`), so a 200 proves workerd is warm — not merely bound.
    statusUrl: `${origin}/status`,
    restartUrl: `${WRANGLER_SUPERVISOR_ORIGIN}/restart`,
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (message) => console.log(message),
  };
}

/** Per-worker-process state. Playwright restarts a worker after a failure, so
 *  the abort latch only shortcuts specs inside the same process; a fresh worker
 *  re-probes (a refused connection costs milliseconds) and may recover. */
const state = createLeaderHealthState();

export const test = base.extend<{ leaderAlive: void }>({
  leaderAlive: [
    async ({ baseURL }, use, testInfo) => {
      const deps = healthDeps(baseURL ?? LEADER_ORIGIN);
      await assertLeaderAlive(deps, state, testInfo.title, 'before');
      await use();
      await assertLeaderAlive(deps, state, testInfo.title, 'after');
    },
    { auto: true },
  ],
});
