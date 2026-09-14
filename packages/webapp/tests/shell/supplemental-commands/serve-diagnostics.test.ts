import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import { FollowerRegistry } from '../../../src/scoops/tray-leader/follower-registry.js';
import { PreviewBridgeManager } from '../../../src/scoops/tray-leader/preview-bridge.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import { setPreviewMinter, setPreviewOp } from '../../../src/shell/preview-minter.js';
import { createServeCommand } from '../../../src/shell/supplemental-commands/serve-command.js';

function createBridgeHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    onPreviewLick: vi.fn(),
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const bridge = new PreviewBridgeManager(context);
  setPreviewOp(async (request) => {
    if (request.type === 'logs') {
      return {
        lifecycleRecords: [...bridge.getPreviewLifecycleRecords(request.previewToken)],
      };
    }
    if (request.type === 'truncate') {
      return {
        cleared: bridge.clearPreviewLifecycleRecords(request.previewToken),
        rearmed: bridge.rearmPreviewAnnouncements(request.previewToken),
      };
    }
    return {};
  });
  return { bridge, options };
}

function connect(bridge: PreviewBridgeManager, previewToken: string, connId: string): void {
  bridge.onBridgeConnected({
    type: 'bridge.connected',
    connId,
    previewToken,
    origin: `https://${previewToken}.example`,
    userAgent: 'test-agent',
    connectedAt: '2026-08-01T00:00:00.000Z',
  });
}

describe('serve preview lifecycle diagnostics', () => {
  beforeEach(() => {
    setPreviewMinter(null);
    setPreviewOp(null);
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
  });

  afterEach(() => {
    setPreviewMinter(null);
    setPreviewOp(null);
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
  });

  it('lists logs oldest-to-newest with announced and suppressed dispositions', async () => {
    const { bridge, options } = createBridgeHarness();
    bridge.registerMintedPreview('site-a', {
      url: 'https://site-a.example',
      title: 'Site A',
      quiet: false,
    });
    connect(bridge, 'site-a', 'first');
    connect(bridge, 'site-a', 'second');
    bridge.onBridgeDisconnected({
      type: 'bridge.disconnected',
      connId: 'second',
      reason: 'closed',
    });

    const lickCount = options.onPreviewLick.mock.calls.length;
    const result = await createServeCommand().execute(['--logs', 'site-a'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('oldest to newest');
    expect(result.stdout).toContain('connected    announced');
    expect(result.stdout).toContain('connected    suppressed');
    expect(result.stdout).toContain('disconnected suppressed');
    expect(result.stdout.indexOf('conn=first')).toBeLessThan(result.stdout.indexOf('conn=second'));
    expect(options.onPreviewLick).toHaveBeenCalledTimes(lickCount);
  });

  it('passes an exact token filter and applies the line limit newest-last', async () => {
    const { bridge } = createBridgeHarness();
    connect(bridge, 'site-a', 'a-1');
    connect(bridge, 'site-b', 'b-1');
    connect(bridge, 'site-b', 'b-2');

    const result = await createServeCommand().execute(
      ['--logs', 'site-b', '--lines', '1'],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('conn=a-1');
    expect(result.stdout).not.toContain('conn=b-1');
    expect(result.stdout).toContain('conn=b-2');
  });

  it('states that an empty recorder is leader-memory-only and resets on restart', async () => {
    createBridgeHarness();

    const result = await createServeCommand().execute(['--logs'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('leader-memory-only');
    expect(result.stdout).toContain('resets on leader restart');
  });

  it('truncate clears records, re-arms the latch, and the next connect announces', async () => {
    const { bridge, options } = createBridgeHarness();
    bridge.registerMintedPreview('site-a', {
      url: 'https://site-a.example',
      title: 'Site A',
      quiet: false,
    });
    connect(bridge, 'site-a', 'first');
    expect(options.onPreviewLick).toHaveBeenCalledTimes(1);

    const result = await createServeCommand().execute(['--truncate', 'site-a'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Cleared 1 preview lifecycle record');
    expect(result.stdout).toContain('re-armed 1 preview announcement');
    expect(bridge.getPreviewLifecycleRecords('site-a')).toEqual([]);

    connect(bridge, 'site-a', 'second');
    expect(options.onPreviewLick).toHaveBeenCalledTimes(2);
    expect(bridge.getPreviewLifecycleRecords('site-a')).toEqual([
      expect.objectContaining({ connId: 'second', announced: true }),
    ]);
  });

  it('routes logs and truncate through panel RPC when no in-realm op exists', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        return op === 'tray-preview-logs' ? { lifecycleRecords: [] } : { cleared: 2, rearmed: 1 };
      },
      dispose: () => {},
    };
    const command = createServeCommand();

    await command.execute(['--logs', 'site-a'], {} as never);
    const truncated = await command.execute(['--truncate', 'site-a'], {} as never);

    expect(truncated.stdout).toContain('Cleared 2 preview lifecycle records');
    expect(calls).toEqual([
      { op: 'tray-preview-logs', payload: { previewToken: 'site-a' } },
      { op: 'tray-preview-truncate', payload: { previewToken: 'site-a' } },
    ]);
  });

  it('validates diagnostic arguments and documents both flags', async () => {
    const command = createServeCommand();
    const help = await command.execute([], {} as never);
    const invalidLines = await command.execute(['--logs', '--lines', '0'], {} as never);
    const truncateLines = await command.execute(['--truncate', '--lines', '2'], {} as never);

    expect(help.stdout).toContain('serve --logs');
    expect(help.stdout).toContain('serve --truncate');
    expect(invalidLines.stderr).toContain('--lines must be a positive integer');
    expect(truncateLines.stderr).toContain('--lines requires --logs');
  });
});
