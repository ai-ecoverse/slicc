/**
 * `mktemp` registration stub.
 *
 * The parser, template expansion and creation loop live in `mktemp/run.ts` and
 * are imported on FIRST USE, not at registration — `index.ts` sits in the
 * kernel worker's boot-critical graph (see
 * `packages/webapp/first-load-budget.json`).
 *
 * Why the command exists here at all, and when to delete it, is in that file's
 * header: it is an overlay ported from
 * [just-bash#377](https://github.com/vercel-labs/just-bash/pull/377), guarded by
 * `tests/shell/supplemental-commands/mktemp-builtin-tripwire.test.ts`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createMktempCommand(): Command {
  return defineCommand('mktemp', async (args, ctx) => {
    const { runMktemp } = await import('./mktemp/run.js');
    return runMktemp(args, ctx);
  });
}
