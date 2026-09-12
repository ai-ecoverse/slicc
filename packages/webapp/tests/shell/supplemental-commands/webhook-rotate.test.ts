import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookCommand } from '../../../src/shell/supplemental-commands/webhook-command.js';

const { call, getClient } = vi.hoisted(() => {
  const call = vi.fn();
  return { call, getClient: vi.fn(() => ({ call })) };
});
vi.mock('../../../src/kernel/panel-rpc.js', () => ({ getPanelRpcClient: getClient }));

describe('webhook rotate', () => {
  beforeEach(() => {
    call.mockReset().mockResolvedValue({ webhookUrl: 'https://hub/wh/private' });
    getClient.mockClear();
  });

  it('uses the leader panel RPC without printing capabilities', async () => {
    const result = await createWebhookCommand().execute(['rotate'], {} as never);
    expect(call).toHaveBeenCalledWith('tray-webhook-rotate', undefined);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('webhook list');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    ['rotate', '--help'],
    ['rotate', 'anything', '--help'],
  ])('answers help without touching the leader: %s', async (...args) => {
    const result = await createWebhookCommand().execute(args, {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rotate');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('rejects arguments without side effects', async () => {
    const result = await createWebhookCommand().execute(['rotate', 'id'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('fails closed and redacts transport errors', async () => {
    call.mockRejectedValue(new Error('https://hub/wh/private rebind-secret'));
    const result = await createWebhookCommand().execute(['rotate'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('retry');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('rebind-secret');
  });
});
