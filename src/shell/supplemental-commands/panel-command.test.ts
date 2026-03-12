import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPanelCommand } from './panel-command.js';
import type { PanelManager } from '../../ui/panel-manager.js';

describe('panel command', () => {
  let mockMgr: Partial<PanelManager>;
  let command: ReturnType<typeof createPanelCommand>;

  beforeEach(() => {
    mockMgr = {
      refresh: vi.fn().mockResolvedValue(undefined),
      available: vi.fn().mockReturnValue([
        { name: 'dash', path: '/workspace/skills/dash/dash.shtml', title: 'Dashboard' },
      ]),
      opened: vi.fn().mockReturnValue([]),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      sendToPanel: vi.fn(),
    };
    // Set the global that the command reads from
    (globalThis as any).window = { __slicc_panelManager: mockMgr };
    command = createPanelCommand();
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  const run = (args: string[]) => {
    return (command as any).execute(args, {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
  };

  it('shows help with no args', async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage:');
  });

  it('list shows available panels', async () => {
    const result = await run(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dash');
    expect(result.stdout).toContain('Dashboard');
  });

  it('list shows [open] for open panels', async () => {
    (mockMgr.opened as ReturnType<typeof vi.fn>).mockReturnValue(['dash']);
    const result = await run(['list']);
    expect(result.stdout).toContain('[open]');
  });

  it('open calls mgr.open', async () => {
    const result = await run(['open', 'dash']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.open).toHaveBeenCalledWith('dash');
  });

  it('open requires name', async () => {
    const result = await run(['open']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('name required');
  });

  it('close calls mgr.close', async () => {
    const result = await run(['close', 'dash']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.close).toHaveBeenCalledWith('dash');
  });

  it('close requires name', async () => {
    const result = await run(['close']);
    expect(result.exitCode).toBe(1);
  });

  it('refresh re-scans and reports count', async () => {
    const result = await run(['refresh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 panel');
    expect(mockMgr.refresh).toHaveBeenCalled();
  });

  it('send pushes JSON data to panel', async () => {
    const result = await run(['send', 'dash', '{"status":"ok"}']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.sendToPanel).toHaveBeenCalledWith('dash', { status: 'ok' });
  });

  it('send rejects invalid JSON', async () => {
    const result = await run(['send', 'dash', 'not json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid JSON');
  });

  it('send requires name', async () => {
    const result = await run(['send']);
    expect(result.exitCode).toBe(1);
  });

  it('send requires data', async () => {
    const result = await run(['send', 'dash']);
    expect(result.exitCode).toBe(1);
  });

  it('unknown subcommand returns error', async () => {
    const result = await run(['unknown']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });

  it('returns error when panel manager not initialized', async () => {
    (globalThis as any).window = {}; // no __slicc_panelManager
    const cmd = createPanelCommand();
    const result = await (cmd as any).execute(['list'], { cwd: '/', env: {}, fs: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not initialized');
  });
});
