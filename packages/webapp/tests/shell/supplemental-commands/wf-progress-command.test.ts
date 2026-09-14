import { describe, expect, it } from 'vitest';
import { createWfProgressCommand } from '../../../src/shell/supplemental-commands/wf-progress-command.js';

describe('__wf_progress', () => {
  it('is a no-op that exits 0', async () => {
    const cmd = createWfProgressCommand();
    expect(cmd.name).toBe('__wf_progress');
    const res = await cmd.execute(['phase', 'Scan'], {
      cwd: '/',
      env: new Map(),
      stdin: '',
    } as any);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });
});
