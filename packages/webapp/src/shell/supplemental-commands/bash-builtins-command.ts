/**
 * Registration stub for the bash builtins `help` advertises but just-bash
 * does not implement.
 *
 * just-bash ships bash's full `help` topic table while implementing only
 * part of it, so the thirteen names below reached command lookup and
 * answered `command not found` (127). `trap` was the dangerous one: the
 * parser accepted `trap 'cleanup' EXIT` and the script kept running, so a
 * handler that was never installed looked like it worked (issue #2816).
 *
 * Custom commands are consulted only after builtins, so these names reach
 * dispatch precisely because upstream has no builtin for them — the list
 * can never shadow a builtin just-bash later implements.
 *
 * Behaviour and usage text live in `bash-builtins/run.ts`, imported on
 * FIRST USE: `index.ts` sits in the kernel worker's boot-critical graph
 * (`packages/webapp/first-load-budget.json`).
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

/**
 * The advertised-but-unimplemented set, and the single source of truth for
 * what gets registered. `bash-builtins-command.test.ts` walks the live
 * `help` listing and asserts nothing outside this list answers 127.
 */
export const BASH_BUILTIN_COMMAND_NAMES: readonly string[] = [
  'bg',
  'caller',
  'disown',
  'enable',
  'fc',
  'fg',
  'jobs',
  'logout',
  'suspend',
  'times',
  'trap',
  'ulimit',
  'umask',
];

export function createBashBuiltinCommands(): Command[] {
  return BASH_BUILTIN_COMMAND_NAMES.map((name) =>
    defineCommand(name, async (args, ctx) => {
      const { runBashBuiltin } = await import('./bash-builtins/run.js');
      return runBashBuiltin(name, args, ctx);
    })
  );
}
