import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import { createCrontaskCommand } from '../../../src/shell/supplemental-commands/crontask-command.js';

interface MockLickManager {
  createCronTask: (
    name: string,
    cron: string,
    scoop?: string
  ) => Promise<{ id: string; name: string; cron: string; scoop?: string; nextRun?: string }>;
  listCronTasks: () => {
    id: string;
    name: string;
    cron: string;
    scoop?: string;
    filter?: string;
    nextRun?: string;
    status: string;
  }[];
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
    it('rejects unknown flags with a non-zero exit (#2255)', async () => {
      const result = await run(['create', '--name', 'my-task', '--cron', '0 * * * *', '--bogus']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unknown flag: --bogus');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('honours -- when delete id starts with a dash', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await run(['delete', '--', '-task123']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Deleted cron task "-task123"');
      expect(mockFetch).toHaveBeenCalledWith('/api/crontasks/-task123', expect.any(Object));
    });

    it('accepts --filter values that start with a dash via --flag=value', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'task-dash',
          name: 'dash-filter',
          cron: '0 * * * *',
          filter: '--not-a-flag',
          status: 'active',
          createdAt: '2026-03-16T00:00:00Z',
        }),
      });

      const result = await run([
        'create',
        '--name',
        'dash-filter',
        '--cron',
        '0 * * * *',
        '--filter=--not-a-flag',
      ]);

      expect(result.exitCode).toBe(0);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/crontasks',
        expect.objectContaining({
          body: JSON.stringify({
            name: 'dash-filter',
            cron: '0 * * * *',
            filter: '--not-a-flag',
            scoop: undefined,
          }),
        })
      );
    });

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
          body: JSON.stringify({
            name: 'my-task',
            cron: '0 * * * *',
            filter: undefined,
            scoop: undefined,
          }),
        })
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

      const result = await run([
        'create',
        '--name',
        'monitor-task',
        '--cron',
        '*/5 * * * *',
        '--scoop',
        'monitor',
      ]);

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
        })
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
        '--name',
        'filtered-task',
        '--cron',
        '*/10 * * * *',
        '--filter',
        '() => Math.random() > 0.5',
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
        })
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
          {
            id: 'task1',
            name: 'filtered',
            cron: '0 * * * *',
            filter: '() => true',
            status: 'active',
          },
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
          {
            id: 'task1',
            name: 'scheduled',
            cron: '0 9 * * *',
            nextRun: '2026-03-17T09:00:00Z',
            status: 'active',
          },
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

    const { createCrontaskCommand: createCmd } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    // Extension realm: no local node-server. Production wiring resolves this
    // once in `shell-and-skills.ts` and injects it — mirrored here explicitly
    // now that the command no longer probes `chrome` itself (#2276).
    command = createCmd({ hasLocalNodeServer: () => false });
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
    it('shows help with create --help', async () => {
      const result = await run(['create', '--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('usage: crontask');
    });

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
      expect(mockLickManager.createCronTask).toHaveBeenCalledWith(
        'ext-task',
        '0 * * * *',
        undefined
      );
    });

    it('creates task with scoop via LickManager', async () => {
      (mockLickManager.createCronTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'task-with-scoop',
        name: 'monitor-task',
        cron: '*/5 * * * *',
        scoop: 'monitor',
      });

      const result = await run([
        'create',
        '--name',
        'monitor-task',
        '--cron',
        '*/5 * * * *',
        '--scoop',
        'monitor',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Scoop:    monitor');
      expect(mockLickManager.createCronTask).toHaveBeenCalledWith(
        'monitor-task',
        '*/5 * * * *',
        'monitor'
      );
    });

    it('rejects --filter in extension mode (CSP restriction)', async () => {
      const result = await run([
        'create',
        '--name',
        'filtered-task',
        '--cron',
        '0 * * * *',
        '--filter',
        '() => true',
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
        {
          id: 'task1',
          name: 'monitor',
          cron: '0 * * * *',
          scoop: 'monitor',
          status: 'active',
          filter: undefined,
        },
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
      (mockLickManager.createCronTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Create failed')
      );

      const result = await run(['create', '--name', 'task', '--cron', '0 * * * *']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Create failed');
    });
  });
});

describe('crontask command — thin-bridge routing', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let command: ReturnType<typeof createCrontaskCommand>;

  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    command = createCrontaskCommand();
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('bridge-tok');
  });

  afterEach(() => {
    vi.clearAllMocks();
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  const run = (args: string[]) => {
    return (command as any).execute(args, { cwd: '/', env: {}, fs: {} as any });
  };

  it('rewrites URL and attaches X-Bridge-Token in bridge mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await run(['list']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:5710/api/crontasks');
    expect(init.headers['X-Bridge-Token']).toBe('bridge-tok');
  });
});

describe('crontask command - extension-delegate mode', () => {
  let command: ReturnType<typeof createCrontaskCommand>;
  let mockLm: {
    createCronTask: ReturnType<typeof vi.fn>;
    listCronTasks: ReturnType<typeof vi.fn>;
    deleteCronTask: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.stubGlobal('chrome', { runtime: { connect: () => undefined } });
    vi.stubGlobal('fetch', vi.fn()); // must NOT be called in delegate mode
    vi.resetModules();
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('delegate-id');
    mockLm = {
      createCronTask: vi.fn().mockResolvedValue({ id: 'c1', name: 'nightly', cron: '0 0 * * *' }),
      listCronTasks: vi.fn().mockReturnValue([]),
      deleteCronTask: vi.fn().mockResolvedValue(true),
    };
    (globalThis as Record<string, unknown>).__slicc_lickManager = mockLm;
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    // Extension realm: no local node-server (#2276 — see the extension-mode
    // block above for why this is now explicit).
    command = createCrontaskCommand({ hasLocalNodeServer: () => false });
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    vi.clearAllMocks();
  });

  const run = (args: string[]) =>
    (command as any).execute(args, { cwd: '/', env: {}, fs: {} as any });

  it('create routes to the worker LickManager, not apiCall/fetch', async () => {
    const result = await run(['create', '--name', 'nightly', '--cron', '0 0 * * *']);
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('nightly', '0 0 * * *', undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('list routes to the worker LickManager, not fetch', async () => {
    const result = await run(['list']);
    expect(result.exitCode).toBe(0);
    expect(mockLm.listCronTasks).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('delete routes to the worker LickManager, not fetch', async () => {
    const result = await run(['delete', 'c1']);
    expect(result.exitCode).toBe(0);
    expect(mockLm.deleteCronTask).toHaveBeenCalledWith('c1');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('crontask command - extension-direct equivalence', () => {
  // A real chrome-extension:// kernel (chrome.runtime.id truthy) is non-node-rest
  // and must route identically to extension-delegate: worker LickManager, no fetch.
  let command: ReturnType<typeof createCrontaskCommand>;
  let mockLm: { createCronTask: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'real-ext-id' } });
    vi.stubGlobal('fetch', vi.fn());
    vi.resetModules();
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    mockLm = {
      createCronTask: vi.fn().mockResolvedValue({ id: 'c1', name: 'nightly', cron: '0 0 * * *' }),
    };
    (globalThis as Record<string, unknown>).__slicc_lickManager = mockLm;
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    // Extension realm: no local node-server (#2276 — see the extension-mode
    // block above for why this is now explicit).
    command = createCrontaskCommand({ hasLocalNodeServer: () => false });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    vi.clearAllMocks();
  });

  it('create routes to the worker LickManager, not apiCall/fetch', async () => {
    const result = await (command as any).execute(
      ['create', '--name', 'nightly', '--cron', '0 0 * * *'],
      { cwd: '/', env: {}, fs: {} as any }
    );
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('nightly', '0 0 * * *', undefined);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('crontask create - default lick target (#2311)', () => {
  // An extra cone's shell carries SLICC_LICK_TARGET=<its folder>; `crontask`
  // falls back to it exactly as `fswatch` does, so its ticks come back to it.
  let command: ReturnType<typeof createCrontaskCommand>;
  let mockLm: { createCronTask: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'real-ext-id' } });
    vi.stubGlobal('fetch', vi.fn());
    vi.resetModules();
    mockLm = {
      createCronTask: vi.fn().mockResolvedValue({ id: 'c1', name: 'digest', cron: '0 9 * * *' }),
    };
    (globalThis as Record<string, unknown>).__slicc_lickManager = mockLm;
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    // Extension realm: no local node-server (#2276 — see the extension-mode
    // block above for why this is now explicit).
    command = createCrontaskCommand({ hasLocalNodeServer: () => false });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    vi.clearAllMocks();
  });

  const run = (args: string[], env: unknown) =>
    (command as any).execute(args, { cwd: '/', env, fs: {} as any });

  it('falls back to SLICC_LICK_TARGET when --scoop is absent', async () => {
    const result = await run(['create', '--name', 'digest', '--cron', '0 9 * * *'], {
      SLICC_LICK_TARGET: 'cone-research',
    });
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'cone-research');
  });

  it('reads the same variable out of a Map env (just-bash hands either)', async () => {
    const result = await run(
      ['create', '--name', 'digest', '--cron', '0 9 * * *'],
      new Map([['SLICC_LICK_TARGET', 'cone-research']])
    );
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'cone-research');
  });

  it('an explicit --scoop always wins over the shell default', async () => {
    const result = await run(
      ['create', '--name', 'digest', '--cron', '0 9 * * *', '--scoop', 'watcher'],
      { SLICC_LICK_TARGET: 'cone-research' }
    );
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'watcher');
  });

  it('stays untargeted (default root) when the shell carries no target', async () => {
    const result = await run(['create', '--name', 'digest', '--cron', '0 9 * * *'], {});
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', undefined);
  });

  it('accepts a cone name as an explicit --scoop', async () => {
    const result = await run(
      ['create', '--name', 'digest', '--cron', '0 9 * * *', '--scoop', 'Research'],
      {}
    );
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'Research');
  });
});

/**
 * #2524 — a cron task pointed at a unit that does not exist ticked forever into
 * nothing, and `LickManager.init` deleted it on the next boot anyway. It is
 * refused at create time now; the omitted-`--scoop` path stays as it was (#2525).
 */
describe('crontask create — unresolvable --scoop (#2524)', () => {
  let command: ReturnType<typeof createCrontaskCommand>;
  let mockLm: {
    createCronTask: ReturnType<typeof vi.fn>;
    resolveLickTarget: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'real-ext-id' } });
    vi.stubGlobal('fetch', vi.fn());
    vi.resetModules();
    mockLm = {
      createCronTask: vi.fn().mockResolvedValue({ id: 'c1', name: 'digest', cron: '0 9 * * *' }),
      resolveLickTarget: vi.fn((target: string) =>
        target === 'cone' ? { status: 'resolved' } : { status: 'unresolved', candidates: ['cone'] }
      ),
    };
    (globalThis as Record<string, unknown>).__slicc_lickManager = mockLm;
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    // Extension realm: no local node-server (#2276 — see the extension-mode
    // block above for why this is now explicit).
    command = createCrontaskCommand({ hasLocalNodeServer: () => false });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    vi.clearAllMocks();
  });

  const run = (args: string[], env: unknown = {}) =>
    (command as any).execute(args, { cwd: '/', env, fs: {} as any });

  it('refuses a target that matches no live unit and creates nothing', async () => {
    const result = await run([
      'create',
      '--name',
      'ghost-target-probe',
      '--scoop',
      'ghost-cone-does-not-exist',
      '--cron',
      '5 4 1 1 *',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('crontask create: --scoop "ghost-cone-does-not-exist"');
    expect(result.stderr).toContain('valid targets: cone');
    expect(mockLm.createCronTask).not.toHaveBeenCalled();
  });

  it('accepts a target that resolves', async () => {
    const result = await run([
      'create',
      '--name',
      'digest',
      '--scoop',
      'cone',
      '--cron',
      '0 9 * * *',
    ]);
    expect(result.exitCode).toBe(0);
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'cone');
  });

  it('validates --scoop only after --name and --cron are satisfied', async () => {
    const result = await run(['create', '--scoop', 'ghost-cone-does-not-exist']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--name is required');
    expect(mockLm.resolveLickTarget).not.toHaveBeenCalled();
  });

  // #2525 owns the omitted-`--scoop` path; this change must not touch it.
  it('does not validate the shell default when --scoop is omitted', async () => {
    const result = await run(['create', '--name', 'digest', '--cron', '0 9 * * *'], {
      SLICC_LICK_TARGET: 'cone-research',
    });
    expect(result.exitCode).toBe(0);
    expect(mockLm.resolveLickTarget).not.toHaveBeenCalled();
    expect(mockLm.createCronTask).toHaveBeenCalledWith('digest', '0 9 * * *', 'cone-research');
  });
});

// ─── Proxy-path parity for cone addressing (#2311) ────────────────────────
//
// The side-panel terminal reaches the LickManager over BroadcastChannel. A
// cone target must survive that hop byte-for-byte — the target string is
// resolved centrally in `routeFormattedLickToCone`, so the proxy's only job
// is to not mangle it. These tests do NOT preset `__slicc_lickManager`,
// forcing the command through the proxy branch. `webhook`'s matching
// parity test lives in `webhook-command.test.ts` (it needs the tray-leader
// singleton for its URL).
describe('lick registration — cone targets round-trip through the proxy', () => {
  class MockBroadcastChannel {
    static channels = new Map<string, Set<MockBroadcastChannel>>();
    name: string;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      const set = MockBroadcastChannel.channels.get(name) ?? new Set();
      set.add(this);
      MockBroadcastChannel.channels.set(name, set);
    }
    postMessage(data: unknown): void {
      const peers = MockBroadcastChannel.channels.get(this.name);
      if (!peers) return;
      for (const ch of peers) {
        if (ch !== this && ch.onmessage) ch.onmessage(new MessageEvent('message', { data }));
      }
    }
    close(): void {
      MockBroadcastChannel.channels.get(this.name)?.delete(this);
    }
  }

  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { id: 'ext-test-id' } });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('self', {
      location: {
        href: 'chrome-extension://ext-test-id/index.html',
        origin: 'chrome-extension://ext-test-id',
      },
    });
    MockBroadcastChannel.channels.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockBroadcastChannel.channels.clear();
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });

  async function hostedManager() {
    const lm = {
      createWebhook: vi.fn(),
      listWebhooks: vi.fn().mockReturnValue([]),
      deleteWebhook: vi.fn(),
      createCronTask: vi.fn().mockResolvedValue({ id: 'ct-px', name: 'digest', cron: '0 9 * * *' }),
      listCronTasks: vi.fn().mockReturnValue([]),
      deleteCronTask: vi.fn(),
    };
    const { startLickManagerHost } = await import('../../../src/base/lick-manager-proxy.js');
    startLickManagerHost(lm as never);
    return lm;
  }

  it('forwards an explicit cone folder from `crontask create`', async () => {
    const lm = await hostedManager();
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    const result = await (
      createCrontaskCommand({ hasLocalNodeServer: () => false }) as any
    ).execute(['create', '--name', 'digest', '--cron', '0 9 * * *', '--scoop', 'cone-research'], {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
    expect(result.exitCode).toBe(0);
    expect(lm.createCronTask).toHaveBeenCalledWith(
      'digest',
      '0 9 * * *',
      'cone-research',
      undefined
    );
  });

  it('forwards the shell default from `crontask create` with no --scoop', async () => {
    const lm = await hostedManager();
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    const result = await (
      createCrontaskCommand({ hasLocalNodeServer: () => false }) as any
    ).execute(['create', '--name', 'digest', '--cron', '0 9 * * *'], {
      cwd: '/',
      env: { SLICC_LICK_TARGET: 'cone-research' },
      fs: {} as any,
    });
    expect(result.exitCode).toBe(0);
    expect(lm.createCronTask).toHaveBeenCalledWith(
      'digest',
      '0 9 * * *',
      'cone-research',
      undefined
    );
  });

  // #2524 parity: the proxy hop must carry the REJECTION too, otherwise the
  // side-panel terminal keeps registering black holes the standalone shell refuses.
  it('refuses an unresolvable --scoop through the proxy', async () => {
    const lm = await hostedManager();
    (lm as unknown as { resolveLickTarget: unknown }).resolveLickTarget = vi.fn(() => ({
      status: 'unresolved',
      candidates: ['cone'],
    }));
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    const result = await (
      createCrontaskCommand({ hasLocalNodeServer: () => false }) as any
    ).execute(['create', '--name', 'digest', '--cron', '0 9 * * *', '--scoop', 'ghost-cone'], {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('matches no live cone or scoop');
    expect(lm.createCronTask).not.toHaveBeenCalled();
  });

  it('lists cron tasks through the proxy (no direct manager present)', async () => {
    const lm = await hostedManager();
    lm.listCronTasks.mockReturnValue([
      { id: 'ct-px', name: 'digest', cron: '0 9 * * *', scoop: 'cone-research', status: 'active' },
    ]);
    const { createCrontaskCommand } = await import(
      '../../../src/shell/supplemental-commands/crontask-command.js'
    );
    const result = await (
      createCrontaskCommand({ hasLocalNodeServer: () => false }) as any
    ).execute(['list'], {
      cwd: '/',
      env: {},
      fs: {} as any,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('-> cone-research');
  });
});
