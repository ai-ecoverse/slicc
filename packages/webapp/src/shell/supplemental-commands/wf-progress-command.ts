import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

export function createWfProgressCommand(): Command {
  return defineCommand('__wf_progress', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
}
