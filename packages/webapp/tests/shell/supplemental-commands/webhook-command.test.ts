import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { LickManager, WebhookEntry } from '../../../src/scoops/lick-manager.js';
import type { LeaderTraySession } from '../../../src/scoops/tray-leader.js';

const SESSION: LeaderTraySession = {
  workerBaseUrl: 'https://hub.slicc.dev',
  trayId: 'tray-abc',
  createdAt: new Date().toISOString(),
  controllerId: 'ctrl-1',
  controllerUrl: 'https://hub.slicc.dev/controller/abc',
  joinUrl: 'https://hub.slicc.dev/join/abc',
  webhookUrl: 'https://hub.slicc.dev/webhook/abc',
  runtime: 'browser',
};

function buildLickManagerMock(overrides: Partial<LickManager> = {}): LickManager {
  return {
    createWebhook: vi.fn(),
    listWebhooks: vi.fn().mockReturnValue([]),
    deleteWebhook: vi.fn(),
    createCronTask: vi.fn(),
    listCronTasks: vi.fn(),
    deleteCronTask: vi.fn(),
    handleWebhookEvent: vi.fn(),
    emitEvent: vi.fn(),
    ...overrides,
  } as unknown as LickManager;
}

function stubSelfLocation(href: string): void {
  vi.stubGlobal('self', { location: { href, origin: new URL(href).origin } });
}

/**
 * Load the command and the leader-tray singleton from the SAME module
 * graph. `vi.resetModules()` reinstantiates singletons; the test must
 * share the freshly-loaded `tray-leader` module instance with the
 * webhook-command, otherwise `setLeaderTrayRuntimeStatus` mutates a
 * different singleton than the command observes.
 */
async function loadCommandAndTrayLeader() {
  const trayMod = await import('../../../src/scoops/tray-leader.js');
  const cmdMod = await import('../../../src/shell/supplemental-commands/webhook-command.js');
  return {
    command: cmdMod.createWebhookCommand(),
    setStatus: trayMod.setLeaderTrayRuntimeStatus,
  };
}

describe('webhook command — help and argument validation', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
    stubSelfLocation('http://localhost:5710/index.html');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows help with --help', async () => {
    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('webhook <command>');
  });

  it('rejects create without --scoop', async () => {
    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['create', '--name', 'test'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scoop is required');
  });

  it('rejects unknown subcommand', async () => {
    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['bogus'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "bogus"');
  });

  it('rejects delete without ID', async () => {
    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['delete'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('delete requires an ID');
  });
});

describe('webhook command — standalone mode (direct LickManager)', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
    stubSelfLocation('http://localhost:5710/index.html');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });

  it('create routes to direct LickManager and renders the local node-server URL', async () => {
    const entry: WebhookEntry = {
      id: 'wh-1',
      name: 'github',
      scoop: 'pr-reviewer',
      createdAt: new Date().toISOString(),
    };
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockResolvedValue(entry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(
      ['create', '--scoop', 'pr-reviewer', '--name', 'github'],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(lm.createWebhook).toHaveBeenCalledWith('github', 'pr-reviewer', undefined);
    expect(result.stdout).toContain('Created webhook "github"');
    expect(result.stdout).toContain('ID:  wh-1');
    expect(result.stdout).toContain('URL: http://localhost:5710/webhooks/wh-1');
  });

  it('list renders every entry with the local node-server URL', async () => {
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', scoop: 'pr', createdAt: new Date().toISOString() },
      {
        id: 'wh-2',
        name: 'slack',
        scoop: 'relay',
        createdAt: new Date().toISOString(),
        filter: '(e) => true',
      },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['list'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('http://localhost:5710/webhooks/wh-1');
    expect(result.stdout).toContain('http://localhost:5710/webhooks/wh-2');
    expect(result.stdout).toContain('[filtered]');
  });

  it('delete forwards to direct LickManager', async () => {
    const lm = buildLickManagerMock({
      deleteWebhook: vi.fn().mockResolvedValue(true),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['delete', 'wh-1'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted webhook "wh-1"');
    expect(lm.deleteWebhook).toHaveBeenCalledWith('wh-1');
  });

  it('delete reports not-found when LickManager returns false', async () => {
    const lm = buildLickManagerMock({
      deleteWebhook: vi.fn().mockResolvedValue(false),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['delete', 'missing'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('renders tray webhook URL when a leader session is active', async () => {
    const entry: WebhookEntry = {
      id: 'wh-9',
      name: 'github',
      scoop: 'pr',
      createdAt: new Date().toISOString(),
    };
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockResolvedValue(entry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: SESSION, error: null });

    const result = await command.execute(
      ['create', '--scoop', 'pr', '--name', 'github'],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('URL: https://hub.slicc.dev/webhook/abc/wh-9');
  });
});

describe('webhook command — extension mode', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { id: 'ext-test-id' } });
    stubSelfLocation('chrome-extension://ext-test-id/index.html');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });

  it('rejects --filter with CSP message', async () => {
    const lm = buildLickManagerMock();
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: SESSION, error: null });

    const result = await command.execute(
      ['create', '--scoop', 'pr', '--filter', '(e) => true'],
      {} as never
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--filter is not supported in extension mode');
    expect(lm.createWebhook).not.toHaveBeenCalled();
  });

  it('refuses create when state is not leader (follower / inactive)', async () => {
    const lm = buildLickManagerMock();
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    // default state is `inactive`

    const result = await command.execute(['create', '--scoop', 'pr'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('extension-leader mode');
    expect(result.stderr).toContain('"inactive"');
    expect(lm.createWebhook).not.toHaveBeenCalled();
  });

  it('refuses create when leader but session not yet attached', async () => {
    const lm = buildLickManagerMock();
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: null, error: null });

    const result = await command.execute(['create', '--scoop', 'pr'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not connected yet');
    expect(lm.createWebhook).not.toHaveBeenCalled();
  });

  it('creates webhook with tray URL when leader + session present', async () => {
    const entry: WebhookEntry = {
      id: 'wh-9',
      name: 'github',
      scoop: 'pr',
      createdAt: new Date().toISOString(),
    };
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockResolvedValue(entry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: SESSION, error: null });

    const result = await command.execute(
      ['create', '--scoop', 'pr', '--name', 'github'],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('URL: https://hub.slicc.dev/webhook/abc/wh-9');
  });
});
