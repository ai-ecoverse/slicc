import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

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
