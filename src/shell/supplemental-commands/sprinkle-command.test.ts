import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSprinkleCommand } from './sprinkle-command.js';
import type { SprinkleManager } from '../../ui/sprinkle-manager.js';

describe('sprinkle command', () => {
  let mockMgr: Partial<SprinkleManager>;
  let command: ReturnType<typeof createSprinkleCommand>;

  beforeEach(() => {
    mockMgr = {
      refresh: vi.fn().mockResolvedValue(undefined),
      available: vi.fn().mockReturnValue([
        { name: 'dash', path: '/shared/sprinkles/dash/dash.shtml', title: 'Dashboard', autoOpen: false },
      ]),
      opened: vi.fn().mockReturnValue([]),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      sendToSprinkle: vi.fn(),
    };
    // Set the global that the command reads from
    (globalThis as any).window = { __slicc_sprinkleManager: mockMgr };
    command = createSprinkleCommand();
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

  it('list shows available sprinkles', async () => {
    const result = await run(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dash');
    expect(result.stdout).toContain('Dashboard');
  });

  it('list shows [open] for open sprinkles', async () => {
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
    expect(result.stdout).toContain('1 sprinkle');
    expect(mockMgr.refresh).toHaveBeenCalled();
  });

  it('send pushes JSON data to sprinkle', async () => {
    const result = await run(['send', 'dash', '{"status":"ok"}']);
    expect(result.exitCode).toBe(0);
    expect(mockMgr.sendToSprinkle).toHaveBeenCalledWith('dash', { status: 'ok' });
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

  it('returns error when sprinkle manager not initialized', async () => {
    (globalThis as any).window = {}; // no __slicc_sprinkleManager
    const cmd = createSprinkleCommand();
    const result = await (cmd as any).execute(['list'], { cwd: '/', env: {}, fs: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not initialized');
  });
});
