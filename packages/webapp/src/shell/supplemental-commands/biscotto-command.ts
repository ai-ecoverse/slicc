/**
 * `biscotto` / `biscotti` registration stub.
 *
 * The argument grammar and the panel-RPC calls live in `biscotto/run.ts` and
 * are imported on FIRST USE, not at registration: `index.ts` is in the kernel
 * worker's boot-critical graph, and a command nobody has typed yet has no
 * business being downloaded before the terminal opens (see
 * `packages/webapp/first-load-budget.json`).
 *
 * Same stub+run split as `pdftk`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createBiscottoCommand(name: string = 'biscotto'): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runBiscotto } = await import('./biscotto/run.js');
    return runBiscotto(name, args, ctx);
  });
}
