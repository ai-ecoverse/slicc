/**
 * `curlwright` registration stub (issue #2406).
 *
 * The command's implementation — the curl argv grammar, body assembly,
 * `--write-out` and the page-context fetch — lives in `curlwright/run.ts`
 * and is imported on FIRST USE, not at registration. `index.ts` is in the
 * kernel worker's boot-critical graph, and a shell command nobody has
 * typed yet has no business being downloaded before the terminal opens
 * (see the first-load budget in `packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { CurlwrightBrowser } from './curlwright/run.js';

/**
 * Register `curlwright`. `browser` is optional so the command stays
 * discoverable on floats with no CDP backend — it then explains itself
 * rather than going missing.
 */
export function createCurlwrightCommand(browser: CurlwrightBrowser | null | undefined): Command {
  return defineCommand('curlwright', async (args, ctx) => {
    const { runCurlwright } = await import('./curlwright/run.js');
    return runCurlwright(browser, args, ctx);
  });
}
