import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

/**
 * No-op `__wf_progress` command. The workflow prelude fires
 * `exec.spawn(['__wf_progress', kind, text])` on every phase()/log(); the
 * WorkflowRunManager taps that at the ctx.exec boundary in a backgrounded run.
 * In untapped contexts (--wait, plain terminal) this no-op keeps the emit safe.
 */
export function createWfProgressCommand(): Command {
  return defineCommand('__wf_progress', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
}
