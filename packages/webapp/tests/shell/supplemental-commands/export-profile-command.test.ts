import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const call = vi.fn();
let rpcAvailable = true;
vi.mock('../../../src/kernel/panel-rpc.js', () => ({
  getPanelRpcClient: () => (rpcAvailable ? { call } : null),
}));

import {
  createExportProfileCommand,
  EXPORT_PROFILE_HELP,
} from '../../../src/shell/supplemental-commands/export-profile-command.js';
import { registerProfileExportRunner } from '../../../src/transcript/profile-export-provider.js';

const ctx = () => mockCommandContext();

afterEach(() => {
  call.mockReset();
  rpcAvailable = true;
});

describe('export-profile', () => {
  it('prints help that says what it exports and what never moves', async () => {
    const result = await createExportProfileCommand().execute(['--help'], ctx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(EXPORT_PROFILE_HELP);
    expect(result.stdout).toContain('slicc6-profile-<date>.zip');
    expect(result.stdout).toContain('NOT exported');
    expect(result.stdout).toContain('--dry-run');
  });

  it('asks the leader page over panel RPC from the worker', async () => {
    call.mockResolvedValue({ report: 'export-profile: saved x.zip\n', archives: ['x.zip'] });
    const result = await createExportProfileCommand().execute([], ctx());
    expect(result).toMatchObject({ exitCode: 0, stdout: 'export-profile: saved x.zip\n' });
    expect(call).toHaveBeenCalledWith('profile-export', { dryRun: false }, expect.any(Object));
  });

  it('runs in this realm when the page registered a runner', async () => {
    const run = vi.fn(async () => ({ report: 'dry\n', archives: [] }));
    const teardown = registerProfileExportRunner(run);
    try {
      const result = await createExportProfileCommand().execute(['--dry-run'], ctx());
      expect(result.stdout).toBe('dry\n');
      expect(run).toHaveBeenCalledWith({ dryRun: true });
      expect(call).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it('rejects unknown arguments', async () => {
    const result = await createExportProfileCommand().execute(['--all'], ctx());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown argument "--all"');
  });

  it('reports a failure, including no leader tab', async () => {
    call.mockRejectedValue(new Error('redaction-unavailable'));
    const failed = await createExportProfileCommand().execute(['-n'], ctx());
    expect(failed).toMatchObject({
      exitCode: 1,
      stderr: 'export-profile: redaction-unavailable\n',
    });
    rpcAvailable = false;
    const none = await createExportProfileCommand().execute([], ctx());
    expect(none.stderr).toContain('none is connected');
    call.mockRejectedValue('boom');
    rpcAvailable = true;
    const odd = await createExportProfileCommand().execute([], ctx());
    expect(odd.stderr).toBe('export-profile: boom\n');
  });
});
