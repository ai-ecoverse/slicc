import type { Command } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockCommandContext } from '../helpers/mock-command-context.js';

/**
 * fswatch maintains a module-level registry of active watchers, so each test
 * re-imports the command with a fresh module graph to stay isolated.
 */
async function freshCommand(): Promise<Command> {
  vi.resetModules();
  const mod = await import('../../../src/shell/supplemental-commands/fswatch-command.js');
  return mod.createFsWatchCommand();
}

type WatchCallback = (events: Array<{ type: string; path: string }>) => void;

interface MockWatcher {
  watch: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  lastFilter?: (path: string) => boolean;
  fire: (events: Array<{ type: string; path: string }>) => void;
}

function installWatcher(): MockWatcher {
  const unsubscribe = vi.fn();
  let cb: WatchCallback | undefined;
  const watcher: MockWatcher = {
    unsubscribe,
    watch: vi.fn((_base: string, filter: (p: string) => boolean, callback: WatchCallback) => {
      watcher.lastFilter = filter;
      cb = callback;
      return unsubscribe;
    }),
    fire: (events) => cb?.(events),
  };
  (globalThis as unknown as { __slicc_fs_watcher?: unknown }).__slicc_fs_watcher = watcher;
  return watcher;
}

describe('fswatch command', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_fs_watcher;
    delete (globalThis as Record<string, unknown>).__slicc_lick_handler;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_fs_watcher;
    delete (globalThis as Record<string, unknown>).__slicc_lick_handler;
  });

  it('has correct name', async () => {
    const cmd = await freshCommand();
    expect(cmd.name).toBe('fswatch');
  });

  it('shows help with no subcommand', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute([], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: fswatch');
  });

  it('shows help with --help', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['--help'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: fswatch');
  });

  it('lists nothing when no watchers are active', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['list'], mockCommandContext());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No active file watchers.\n');
  });

  it('errors on delete without an id', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['delete'], mockCommandContext());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('fswatch: delete requires an ID\n');
  });

  it('errors on delete of an unknown id', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['delete', 'fsw-999'], mockCommandContext());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('fswatch: watcher not found: fsw-999\n');
  });

  it('errors on an unknown subcommand', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['bogus'], mockCommandContext());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('fswatch: unknown command: bogus\n');
  });

  it('errors when create is missing --path or --pattern', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(['create', '--path', '/workspace'], mockCommandContext());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('fswatch: --path and --pattern are required\n');
  });

  it('errors when the VFS watcher hook is unavailable', async () => {
    const cmd = await freshCommand();
    const result = await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.md'],
      mockCommandContext()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('fswatch: file system watcher not available\n');
  });

  it('creates a watcher and reports its metadata', async () => {
    const watcher = installWatcher();
    const cmd = await freshCommand();
    const result = await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.md', '--scoop', 'andy', '--name', 'docs'],
      mockCommandContext()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created file watcher "docs"');
    expect(result.stdout).toContain('ID:      fsw-1');
    expect(result.stdout).toContain('Path:    /workspace');
    expect(result.stdout).toContain('Pattern: *.md');
    expect(result.stdout).toContain('Scoop:   andy');
    expect(watcher.watch).toHaveBeenCalledOnce();
  });

  it('derives a default name from pattern and path when --name is omitted', async () => {
    installWatcher();
    const cmd = await freshCommand();
    const result = await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.bsh'],
      mockCommandContext()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created file watcher "*.bsh in /workspace"');
  });

  it('builds a glob filter that matches by filename', async () => {
    const watcher = installWatcher();
    const cmd = await freshCommand();
    await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.md'],
      mockCommandContext()
    );
    expect(watcher.lastFilter?.('/workspace/notes.md')).toBe(true);
    expect(watcher.lastFilter?.('/workspace/script.bsh')).toBe(false);
  });

  it('routes change events to the lick handler with scoop targeting', async () => {
    const watcher = installWatcher();
    const lickHandler = vi.fn();
    (globalThis as Record<string, unknown>).__slicc_lick_handler = lickHandler;

    const cmd = await freshCommand();
    await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.md', '--scoop', 'andy'],
      mockCommandContext()
    );

    watcher.fire([{ type: 'change', path: '/workspace/notes.md' }]);

    expect(lickHandler).toHaveBeenCalledOnce();
    const event = lickHandler.mock.calls[0][0];
    expect(event.type).toBe('fswatch');
    expect(event.targetScoop).toBe('andy');
    expect(event.changes).toEqual([{ type: 'change', path: '/workspace/notes.md' }]);
  });

  it('lists then deletes an active watcher', async () => {
    const watcher = installWatcher();
    const cmd = await freshCommand();
    await cmd.execute(
      ['create', '--path', '/workspace', '--pattern', '*.md', '--name', 'docs'],
      mockCommandContext()
    );

    const listed = await cmd.execute(['list'], mockCommandContext());
    expect(listed.stdout).toContain('ID: fsw-1');
    expect(listed.stdout).toContain('Name:    docs');

    const deleted = await cmd.execute(['delete', 'fsw-1'], mockCommandContext());
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toBe('Deleted watcher "docs" (fsw-1)\n');
    expect(watcher.unsubscribe).toHaveBeenCalledOnce();

    const afterDelete = await cmd.execute(['list'], mockCommandContext());
    expect(afterDelete.stdout).toBe('No active file watchers.\n');
  });
});
