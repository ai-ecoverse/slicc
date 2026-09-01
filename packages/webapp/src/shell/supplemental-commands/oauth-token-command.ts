/**
 * `oauth-token` registration stub.
 *
 * Provider mode, the declarative intercept modes, and the diagnostics
 * (`--list` / `--check` / `--renew` / `--expire`) live in `oauth-token/run.ts`
 * and load on first use, keeping them out of the kernel worker's
 * boot-critical graph (`packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createOAuthTokenCommand(): Command {
  return defineCommand('oauth-token', async (args, ctx) => {
    const { runOAuthToken } = await import('./oauth-token/run.js');
    return runOAuthToken(args, ctx);
  });
}
