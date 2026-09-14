import { test as base, expect } from '@playwright/test';
import {
  assertLeaderAlive,
  createLeaderHealthState,
  type LeaderHealthDeps,
  RESTART_TIMEOUT_MS,
} from './leader-health.js';
import { LEADER_ORIGIN, WRANGLER_SUPERVISOR_ORIGIN } from './playwright.config.js';

export { WRANGLER_CRASHED, WranglerCrashedError } from './leader-health.js';
export { expect };

function healthDeps(origin: string): LeaderHealthDeps {
  return {
    statusUrl: `${origin}/status`,
    restartUrl: `${WRANGLER_SUPERVISOR_ORIGIN}/restart`,
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (message) => console.log(message),
  };
}

const state = createLeaderHealthState();

export const test = base.extend<{ leaderAlive: void }>({
  leaderAlive: [
    async ({ baseURL }, use, testInfo) => {
      const deps = healthDeps(baseURL ?? LEADER_ORIGIN);

      const grantRestartBudget = (): void => {
        testInfo.setTimeout(testInfo.timeout + RESTART_TIMEOUT_MS);
      };
      await assertLeaderAlive(deps, state, testInfo.title, 'before', grantRestartBudget);
      await use();
      await assertLeaderAlive(deps, state, testInfo.title, 'after', grantRestartBudget);
    },
    { auto: true },
  ],
});
