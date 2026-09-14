import type { Command, ResolvedCommandContext } from 'just-bash';
import { type ProgressEmitter, progressLabel } from './emitter.js';

type CommandExecResult = Awaited<ReturnType<Command['execute']>>;

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
  skip?: ReadonlySet<string>;
}

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
