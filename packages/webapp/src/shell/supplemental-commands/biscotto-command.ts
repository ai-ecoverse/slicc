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

export interface BiscottoCommandOptions {
  /**
   * The unit (cone JID) whose shell runs the command. A seat is bound
   * to it at mint, so the guest sees that unit and nothing else.
   */
  getParentJid?: () => string | undefined;
  /**
   * Whether that unit is a scoop (a child unit). A seat cannot be minted from
   * one: guests, like users, never talk to a scoop directly.
   */
  isScoop?: () => boolean;
}

export function createBiscottoCommand(
  name: string = 'biscotto',
  options: BiscottoCommandOptions = {}
): Command {
  return defineCommand(name, async (args, ctx) => {
    const { runBiscotto } = await import('./biscotto/run.js');
    return runBiscotto(name, args, ctx, options.getParentJid?.(), options.isScoop?.() === true);
  });
}
