import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCrontaskCommand } from './crontask-command.js';

interface MockLickManager {
  createCronTask: (name: string, cron: string, scoop?: string) => Promise<{ id: string; name: string; cron: string; scoop?: string; nextRun?: string }>;
  listCronTasks: () => { id: string; name: string; cron: string; scoop?: string; filter?: string; nextRun?: string; status: string }[];
  deleteCronTask: (id: string) => Promise<boolean>;
}

describe('crontask command - CLI mode', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let command: ReturnType<typeof createCrontaskCommand>;

  beforeEach(() => {
    // Ensure chrome global is undefined for CLI mode
    vi.stubGlobal('chrome', undefined);
    vi.resetModules();

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    command = createCrontaskCommand();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const run = (args: string[]) => {
    return (command as any).execute(args, {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
  };

  describe('help output', () => {
    it('shows help with no args', async () => {
      const result = await run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: crontask');
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('create');
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('delete');
    });

    it('shows help with --help flag', async () => {
      const result = await run(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: crontask');
    });

    it('shows help with -h flag', async () => {
      const result = await run(['-h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: crontask');
    });

    it('includes cron expression examples in help', async () => {
      const result = await run(['--help']);
      expect(result.stdout).toContain('Cron Expression:');
      expect(result.stdout).toContain('minute');
      expect(result.stdout).toContain('Examples:');
    });
  });

  describe('create subcommand', () => {
    it('requires --name argument', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'task1', name: 'test', cron: '0 * * * *' }),
      });

      const result = await run(['create', '--cron', '0 * * * *']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--name is required');
    });

    it('requires --cron argument', async () => {
      const result = await run(['create', '--name', 'test-task']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--cron is required');
    });

    it('creates cron task with minimal args (name + cron)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'task123',
          name: 'my-task',
          cron: '0 * * * *',
          status: 'active',
          createdAt: '2026-03-16T00:00:00Z',
        }),
      });

      const result = await run(['create', '--name', 'my-task', '--cron', '0 * * * *']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Created cron task "my-task"');
      expect(result.stdout).toContain('ID:       task123');
      expect(result.stdout).toContain('Cron:     0 * * * *');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/crontasks',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'my-task', cron: '0 * * * *', filter: undefined, scoop: undefined }),
        }),
      );
    });

    it('creates cron task with scoop', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'task456',
          name: 'monitor-task',
          cron: '*/5 * * * *',
          scoop: 'monitor',
          status: 'active',
          createdAt: '2026-03-16T00:00:00Z',
        }),
      });

      const result = await run(['create', '--name', 'monitor-task', '--cron', '*/5 * * * *', '--scoop', 'monitor']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Scoop:    monitor');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/crontasks',
        expect.objectContaining({
          body: JSON.stringify({
            name: 'monitor-task',
            cron: '*/5 * * * *',
            filter: undefined,
            scoop: 'monitor',
          }),
        }),
      );
    });

    it('creates cron task with filter in CLI mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'task789',
          name: 'filtered-task',
          cron: '*/10 * * * *',
          filter: '() => Math.random() > 0.5',
          status: 'active',
          createdAt: '2026-03-16T00:00:00Z',
        }),
      });

      const result = await run([
        'create',
        '--name', 'filtered-task',
        '--cron', '*/10 * * * *',
        '--filter', '() => Math.random() > 0.5',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Filter:');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/crontasks',
        expect.objectContaining({
          body: JSON.stringify({
            name: 'filtered-task',
            cron: '*/10 * * * *',
            filter: '() => Math.random() > 0.5',
            scoop: undefined,
          }),
        }),
      );
    });

    it('returns API error when create fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid cron expression' }),
      });

      const result = await run(['create', '--name', 'bad-task', '--cron', 'invalid']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to create');
      expect(result.stderr).toContain('Invalid cron expression');
    });

    it('handles generic API error without error field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      const result = await run(['create', '--name', 'task', '--cron', '0 * * * *']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to create');
      expect(result.stderr).toContain('unknown error');
    });

    it('includes nextRun in output when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'task999',
          name: 'scheduled-task',
          cron: '0 9 * * 1-5',
          nextRun: '2026-03-17T09:00:00Z',
          status: 'active',
          createdAt: '2026-03-16T00:00:00Z',
        }),
      });

      const result = await run(['create', '--name', 'scheduled-task', '--cron', '0 9 * * 1-5']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Next run:');
    });
  });

  describe('list subcommand', () => {
    it('lists active cron tasks', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'task1', name: 'monitor', cron: '0 * * * *', scoop: 'monitor', status: 'active' },
          { id: 'task2', name: 'alert', cron: '*/5 * * * *', status: 'active' },
        ],
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Active cron tasks:');
      expect(result.stdout).toContain('monitor');
      expect(result.stdout).toContain('alert');
      expect(result.stdout).toContain('-> monitor');
      expect(mockFetch).toHaveBeenCalledWith('/api/crontasks', expect.any(Object));
    });

    it('shows no tasks message when empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active cron tasks');
    });

    it('includes [filtered] indicator for tasks with filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'task1', name: 'filtered', cron: '0 * * * *', filter: '() => true', status: 'active' },
        ],
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[filtered]');
    });

    it('includes nextRun timestamp in list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'task1', name: 'scheduled', cron: '0 9 * * *', nextRun: '2026-03-17T09:00:00Z', status: 'active' },
        ],
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('next:');
    });

    it('returns error when list fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Database error' }),
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to list');
      expect(result.stderr).toContain('Database error');
    });
  });

  describe('delete subcommand', () => {
    it('deletes a cron task by ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await run(['delete', 'task123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted cron task "task123"');
      expect(mockFetch).toHaveBeenCalledWith('/api/crontasks/task123', expect.any(Object));
    });

    it('requires an ID argument', async () => {
      const result = await run(['delete']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('delete requires an ID');
    });

    it('returns 404 error when task not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      });

      const result = await run(['delete', 'nonexistent']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('returns generic error for non-404 failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      });

      const result = await run(['delete', 'task123']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to delete');
      expect(result.stderr).toContain('Server error');
    });
  });

  describe('kill subcommand (alias for delete)', () => {
    it('deletes a cron task using kill alias', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await run(['kill', 'task123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted cron task "task123"');
    });

    it('kill requires an ID argument', async () => {
      const result = await run(['kill']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('kill requires an ID');
    });
  });

  describe('error handling', () => {
    it('handles unknown subcommand', async () => {
      const result = await run(['unknown']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown command "unknown"');
    });

    it('catches thrown errors and returns them in stderr', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await run(['list']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Network error');
    });

    it('handles fetch JSON parse errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('crontask:');
    });
  });
});

describe('crontask command - Extension mode', () => {
  let mockLickManager: MockLickManager;
  let command: ReturnType<typeof createCrontaskCommand>;

  beforeEach(async () => {
    // Set up chrome global BEFORE importing the module
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id' } });

    mockLickManager = {
      createCronTask: vi.fn().mockResolvedValue({
        id: 'ext-task-1',
        name: 'ext-task',
        cron: '0 * * * *',
      }),
      listCronTasks: vi.fn().mockReturnValue([]),
      deleteCronTask: vi.fn().mockResolvedValue(true),
    };

    // Reset modules to get fresh import with chrome global
    vi.resetModules();

    // Set LickManager on globalThis before creating command
    (globalThis as any).__slicc_lickManager = mockLickManager;

    const { createCrontaskCommand: createCmd } = await import('./crontask-command.js');
    command = createCmd();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__slicc_lickManager;
  });

  const run = (args: string[]) => {
    return (command as any).execute(args, {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
  };

  describe('help output', () => {
    it('shows help with no args in extension mode', async () => {
      const result = await run([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: crontask');
    });
  });

  describe('create subcommand in extension', () => {
    it('creates task via LickManager', async () => {
      const result = await run(['create', '--name', 'ext-task', '--cron', '0 * * * *']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Created cron task "ext-task"');
      expect(result.stdout).toContain('ID:       ext-task-1');
      expect(mockLickManager.createCronTask).toHaveBeenCalledWith('ext-task', '0 * * * *', undefined);
    });

    it('creates task with scoop via LickManager', async () => {
      (mockLickManager.createCronTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'task-with-scoop',
        name: 'monitor-task',
        cron: '*/5 * * * *',
        scoop: 'monitor',
      });

      const result = await run(['create', '--name', 'monitor-task', '--cron', '*/5 * * * *', '--scoop', 'monitor']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Scoop:    monitor');
      expect(mockLickManager.createCronTask).toHaveBeenCalledWith('monitor-task', '*/5 * * * *', 'monitor');
    });

    it('rejects --filter in extension mode (CSP restriction)', async () => {
      const result = await run([
        'create',
        '--name', 'filtered-task',
        '--cron', '0 * * * *',
        '--filter', '() => true',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--filter is not supported in extension mode');
      expect(result.stderr).toContain('CSP restriction');
      expect(mockLickManager.createCronTask).not.toHaveBeenCalled();
    });

    it('still requires --name and --cron in extension mode', async () => {
      const result = await run(['create', '--cron', '0 * * * *']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--name is required');

      const result2 = await run(['create', '--name', 'task']);
      expect(result2.exitCode).toBe(1);
      expect(result2.stderr).toContain('--cron is required');
    });

    it('includes nextRun in output when provided', async () => {
      (mockLickManager.createCronTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'task-scheduled',
        name: 'scheduled',
        cron: '0 9 * * 1-5',
        nextRun: '2026-03-17T09:00:00Z',
      });

      const result = await run(['create', '--name', 'scheduled', '--cron', '0 9 * * 1-5']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Next run:');
    });
  });

  describe('list subcommand in extension', () => {
    it('lists tasks via LickManager', async () => {
      (mockLickManager.listCronTasks as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 'task1', name: 'monitor', cron: '0 * * * *', scoop: 'monitor', status: 'active', filter: undefined },
        { id: 'task2', name: 'alert', cron: '*/5 * * * *', status: 'active', filter: undefined },
      ]);

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Active cron tasks:');
      expect(result.stdout).toContain('monitor');
      expect(result.stdout).toContain('alert');
      expect(mockLickManager.listCronTasks).toHaveBeenCalled();
    });

    it('shows no tasks message when empty', async () => {
      (mockLickManager.listCronTasks as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active cron tasks');
    });

    it('includes status and nextRun in output', async () => {
      (mockLickManager.listCronTasks as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        {
          id: 'task1',
          name: 'scheduled',
          cron: '0 9 * * *',
          nextRun: '2026-03-17T09:00:00Z',
          status: 'active',
          filter: undefined,
        },
      ]);

      const result = await run(['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('(active)');
      expect(result.stdout).toContain('next:');
    });
  });

  describe('delete subcommand in extension', () => {
    it('deletes task via LickManager', async () => {
      const result = await run(['delete', 'task123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted cron task "task123"');
      expect(mockLickManager.deleteCronTask).toHaveBeenCalledWith('task123');
    });

    it('returns not found when LickManager returns false', async () => {
      (mockLickManager.deleteCronTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      const result = await run(['delete', 'nonexistent']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('requires ID in extension mode', async () => {
      const result = await run(['delete']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('delete requires an ID');
    });
  });

  describe('kill subcommand in extension', () => {
    it('kills task via LickManager', async () => {
      const result = await run(['kill', 'task123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted cron task "task123"');
      expect(mockLickManager.deleteCronTask).toHaveBeenCalledWith('task123');
    });
  });

  describe('error handling in extension', () => {
    it('handles unknown subcommand in extension mode', async () => {
      const result = await run(['unknown']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown command "unknown"');
    });

    it('catches thrown errors from LickManager', async () => {
      (mockLickManager.listCronTasks as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('LickManager error');
      });

      const result = await run(['list']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('LickManager error');
    });

    it('handles async errors from createCronTask', async () => {
      (mockLickManager.createCronTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Create failed'));

      const result = await run(['create', '--name', 'task', '--cron', '0 * * * *']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Create failed');
    });
  });
});
