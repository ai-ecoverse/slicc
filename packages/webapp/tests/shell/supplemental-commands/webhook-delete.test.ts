import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookCommand } from '../../../src/shell/supplemental-commands/webhook-command.js';

const { call, getClient, deleteWebhook } = vi.hoisted(() => {
  const call = vi.fn();
  return { call, getClient: vi.fn(() => ({ call })), deleteWebhook: vi.fn() };
});
vi.mock('../../../src/kernel/panel-rpc.js', () => ({ getPanelRpcClient: getClient }));
vi.mock('../../../src/shell/supplemental-commands/lick-surface.js', () => ({
  getLickManagerSurface: async () => ({ deleteWebhook }),
}));

describe('webhook delete revocation ordering', () => {
  beforeEach(() => {
    call.mockReset().mockResolvedValue({ ok: true });
    getClient.mockReset().mockReturnValue({ call });
    deleteWebhook.mockReset().mockResolvedValue(true);
  });

  it('revokes before removing the local retry handle', async () => {
    call.mockImplementation(async () => {
      expect(deleteWebhook).not.toHaveBeenCalled();
      return { ok: true };
    });
    const result = await createWebhookCommand().execute(['delete', 'wh-1'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith('tray-webhook-revoke', { webhookId: 'wh-1' });
    expect(deleteWebhook).toHaveBeenCalledWith('wh-1');
  });

  it('retains definition on failure and supports an idempotent retry', async () => {
    call.mockRejectedValueOnce(new Error('rebind-secret private-url'));
    const command = createWebhookCommand();
    const first = await command.execute(['delete', 'wh-1'], {} as never);
    expect(first.exitCode).toBe(1);
    expect(JSON.stringify(first)).not.toMatch(/rebind-secret|private-url/);
    expect(deleteWebhook).not.toHaveBeenCalled();
    expect((await command.execute(['delete', 'wh-1'], {} as never)).exitCode).toBe(0);
  });

  it.each([
    ['delete', 'wh-1', '--help'],
    ['delete', '--help'],
    ['delete', 'wh-1', '--bad'],
  ])('never invokes deletion for help or invalid flags: %s', async (...args) => {
    await createWebhookCommand().execute(args, {} as never);
    expect(call).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it('fails closed for stable URLs without a panel', async () => {
    getClient.mockReturnValue(null as never);
    const result = await createWebhookCommand({
      getLeaderStatus: () => ({
        state: 'leader',
        session: { webhookUrl: 'https://hub/wh/cone.secret' },
      }),
    }).execute(['delete', 'wh-1'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it('preserves local-only deletion without a panel', async () => {
    getClient.mockReturnValue(null as never);
    expect((await createWebhookCommand().execute(['delete', 'wh-1'], {} as never)).exitCode).toBe(
      0
    );
    expect(deleteWebhook).toHaveBeenCalledWith('wh-1');
  });
});
