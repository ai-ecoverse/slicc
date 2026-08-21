/**
 * Generic progress wrapper for a just-bash command: emits an indeterminate
 * `start` before `execute` and `end` after it settles (success, failure or
 * throw). Composes with `wrapCommandForSudo` — sudo inner, progress outer —
 * so a denied command still emits start/end but never runs.
 *
 * Commands that report their own determinate progress (e.g. `sleep` via
 * `makeSleepWithProgress`) are skipped so the card does not show two bars for
 * one command. Trivial built-ins (`echo`, `true`, …) are skipped too: a
 * start/end pair that lives for a microsecond is pure noise on the wire.
 */

import type { Command, ResolvedCommandContext } from 'just-bash';
import { type ProgressEmitter, progressLabel } from './emitter.js';

type CommandExecResult = Awaited<ReturnType<Command['execute']>>;

/** Commands with their own progress source or too short-lived to be worth a card. */
export const PROGRESS_SKIP_COMMANDS: ReadonlySet<string> = new Set([
  'sleep',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'cd',
  'pwd',
  'export',
  'unset',
  'set',
  'shift',
  'local',
  'return',
  'break',
  'continue',
  'exit',
  ':',
  'read',
  'let',
  'declare',
  'typeset',
  'readonly',
  'eval',
  'exec',
  'source',
  '.',
  'alias',
  'unalias',
  'type',
  'command',
  'builtin',
  'wait',
  'trap',
  'basename',
  'dirname',
  'seq',
  'expr',
]);

export interface WrapCommandOptions {
  /** Override the skip set (tests, or a float that wants everything). */
  skip?: ReadonlySet<string>;
}

/** Decorate `command.execute` with indeterminate start/end progress events. */
export function wrapCommandForProgress(
  command: Command,
  emitter: ProgressEmitter,
  options: WrapCommandOptions = {}
): Command {
  const skip = options.skip ?? PROGRESS_SKIP_COMMANDS;
  if (skip.has(command.name)) return command;
  const name = command.name;
  return {
    ...command,
    async execute(args: string[], ctx: ResolvedCommandContext): Promise<CommandExecResult> {
      // No listener (human terminal, detached job): zero overhead path.
      if (!emitter.hasSink()) return command.execute(args, ctx);
      const id = emitter.allocateId('cmd');
      const label = progressLabel(name, args);
      emitter.emit({ id, label, phase: 'start' });
      try {
        return await command.execute(args, ctx);
      } finally {
        emitter.emit({ id, label, phase: 'end' });
      }
    },
  };
}
