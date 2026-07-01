import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(result.stderr).toContain('delete: requires an ID');
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

  it('list reports the empty case', async () => {
    const lm = buildLickManagerMock();
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: SESSION, error: null });

    const result = await command.execute(['list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('No active webhooks\n');
  });

  it('list renders existing webhooks with tray URLs when session is present', async () => {
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', scoop: 'pr', createdAt: new Date().toISOString() },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command, setStatus } = await loadCommandAndTrayLeader();
    setStatus({ state: 'leader', session: SESSION, error: null });

    const result = await command.execute(['list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://hub.slicc.dev/webhook/abc/wh-1');
  });

  it('list renders URL-unavailable placeholder when no tray and emits the hint footer', async () => {
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', scoop: 'pr', createdAt: new Date().toISOString() },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    // default state is `inactive` — no tray session.

    const result = await command.execute(['list'], {} as never);
    expect(result.exitCode).toBe(0);
    // Must NOT render a chrome-extension://… URL — that's the bug.
    expect(result.stdout).not.toContain('chrome-extension://');
    expect(result.stdout).toContain('(URL unavailable');
    expect(result.stdout).toContain('require a leader tray');
  });
});

describe('webhook command — standalone init-pending', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
    stubSelfLocation('http://localhost:5710/index.html');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });

  it('returns init-pending error when standalone host has not booted yet', async () => {
    // No __slicc_lickManager AND standalone mode → no proxy fallback;
    // command must surface a clear "not booted" error.
    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('kernel host has not booted yet');
  });
});

// ─── Extension mode through the actual BroadcastChannel proxy ─────────────
//
// All other "extension mode" tests above set `__slicc_lickManager`
// directly, so they exercise the offscreen-context branch and not the
// side-panel proxy. This describe block does NOT preset the global —
// it installs a MockBroadcastChannel + startLickManagerHost(...) and
// proves the side-panel terminal path round-trips through the proxy.
describe('webhook command — extension side panel → offscreen via BroadcastChannel', () => {
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
    stubSelfLocation('chrome-extension://ext-test-id/index.html');
    MockBroadcastChannel.channels.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockBroadcastChannel.channels.clear();
  });

  it('side-panel webhook create round-trips through the proxy to the offscreen host', async () => {
    const entry: WebhookEntry = {
      id: 'wh-px',
      name: 'github',
      scoop: 'pr',
      createdAt: new Date().toISOString(),
    };
    const mockLickManager = {
      createWebhook: vi.fn().mockResolvedValue(entry),
      listWebhooks: vi.fn(),
      deleteWebhook: vi.fn(),
      createCronTask: vi.fn(),
      listCronTasks: vi.fn(),
      deleteCronTask: vi.fn(),
    };

    // Start the offscreen host with a tray URL resolver.
    const { startLickManagerHost } = await import(
      '../../../../chrome-extension/src/lick-manager-proxy.js'
    );
    startLickManagerHost(mockLickManager as never, {
      getTrayWebhookUrl: () => SESSION.webhookUrl,
    });

    const { command } = await loadCommandAndTrayLeader();
    // NOTE: __slicc_lickManager is intentionally NOT set, forcing
    // the command into the BroadcastChannel proxy branch.

    const result = await command.execute(
      ['create', '--scoop', 'pr', '--name', 'github'],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(mockLickManager.createWebhook).toHaveBeenCalledWith('github', 'pr', undefined);
    expect(result.stdout).toContain('URL: https://hub.slicc.dev/webhook/abc/wh-px');
  });

  it('side-panel webhook list round-trips through the proxy', async () => {
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', scoop: 'pr', createdAt: new Date().toISOString() },
    ];
    const mockLickManager = {
      createWebhook: vi.fn(),
      listWebhooks: vi.fn().mockReturnValue(entries),
      deleteWebhook: vi.fn(),
      createCronTask: vi.fn(),
      listCronTasks: vi.fn(),
      deleteCronTask: vi.fn(),
    };

    const { startLickManagerHost } = await import(
      '../../../../chrome-extension/src/lick-manager-proxy.js'
    );
    startLickManagerHost(mockLickManager as never, {
      getTrayWebhookUrl: () => SESSION.webhookUrl,
    });

    const { command } = await loadCommandAndTrayLeader();

    const result = await command.execute(['list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://hub.slicc.dev/webhook/abc/wh-1');
  });

  it('side-panel webhook delete round-trips through the proxy', async () => {
    const mockLickManager = {
      createWebhook: vi.fn(),
      listWebhooks: vi.fn(),
      deleteWebhook: vi.fn().mockResolvedValue(true),
      createCronTask: vi.fn(),
      listCronTasks: vi.fn(),
      deleteCronTask: vi.fn(),
    };

    const { startLickManagerHost } = await import(
      '../../../../chrome-extension/src/lick-manager-proxy.js'
    );
    startLickManagerHost(mockLickManager as never);

    const { command } = await loadCommandAndTrayLeader();

    const result = await command.execute(['delete', 'wh-1'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(mockLickManager.deleteWebhook).toHaveBeenCalledWith('wh-1');
  });

  it('side-panel webhook create refuses when proxy reports no tray URL', async () => {
    const mockLickManager = {
      createWebhook: vi.fn(),
      listWebhooks: vi.fn(),
      deleteWebhook: vi.fn(),
      createCronTask: vi.fn(),
      listCronTasks: vi.fn(),
      deleteCronTask: vi.fn(),
    };

    const { startLickManagerHost } = await import(
      '../../../../chrome-extension/src/lick-manager-proxy.js'
    );
    // No tray URL resolver → returns null.
    startLickManagerHost(mockLickManager as never);

    const { command } = await loadCommandAndTrayLeader();

    const result = await command.execute(['create', '--scoop', 'pr'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/extension-leader mode|tray session/);
    expect(mockLickManager.createWebhook).not.toHaveBeenCalled();
  });

  it('side-panel webhook list times out cleanly when no offscreen host is listening', async () => {
    // Simulates MV3 killing the offscreen document while the panel is
    // still open — the proxy round-trip never sees a response, so the
    // user sees the proxy's named-op timeout error rather than a hang.
    vi.useFakeTimers();
    try {
      const { command } = await loadCommandAndTrayLeader();
      // No startLickManagerHost() — nothing listens on the channel.
      const promise = command.execute(['list'], {} as never);
      // Use the async variant — it flushes the proxy's dynamic-import
      // microtasks alongside advancing the timer.
      await vi.advanceTimersByTimeAsync(5001);
      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/timed out after 5000ms/);
      expect(result.stderr).toContain('webhook list');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('webhook command — error paths', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', undefined);
    stubSelfLocation('http://localhost:5710/index.html');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
  });

  it('standalone create with --filter forwards filter to LickManager.createWebhook', async () => {
    // Round-1 only tested the extension rejection case. Positive case
    // in standalone must reach createWebhook as the third argument.
    const entry: WebhookEntry = {
      id: 'wh-f',
      name: 'github',
      scoop: 'pr',
      filter: "(e) => e.body.action === 'opened'",
      createdAt: new Date().toISOString(),
    };
    const createWebhook = vi.fn().mockResolvedValue(entry);
    const lm = buildLickManagerMock({ createWebhook });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(
      [
        'create',
        '--scoop',
        'pr',
        '--name',
        'github',
        '--filter',
        "(e) => e.body.action === 'opened'",
      ],
      {} as never
    );

    expect(result.exitCode).toBe(0);
    expect(createWebhook).toHaveBeenCalledWith('github', 'pr', "(e) => e.body.action === 'opened'");
  });

  it('delete that throws routes through the outer catch with subcommand prefix', async () => {
    const deleteWebhook = vi.fn().mockRejectedValue(new Error('IndexedDB corrupted'));
    const lm = buildLickManagerMock({ deleteWebhook });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await command.execute(['delete', 'wh-1'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('webhook delete: IndexedDB corrupted\n');
  });

  it('create surfaces the webhook ID even if URL resolution throws after createWebhook', async () => {
    // Round-1 guard: a thrown resolveWebhookUrlBase must not leak a
    // phantom webhook — the user must still see the new ID. We inject
    // the throw via `vi.spyOn` on the tray-leader module since ESM
    // exports are read-only.
    const entry: WebhookEntry = {
      id: 'wh-recovered',
      name: 'github',
      scoop: 'pr',
      createdAt: new Date().toISOString(),
    };
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockResolvedValue(entry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const trayMod = await import('../../../src/scoops/tray-leader.js');
    const spy = vi.spyOn(trayMod, 'getLeaderStatusWithFallback').mockImplementation(() => {
      throw new Error('storage flake');
    });
    try {
      const result = await command.execute(
        ['create', '--scoop', 'pr', '--name', 'github'],
        {} as never
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ID:  wh-recovered');
      expect(result.stdout).toContain('URL resolution failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('list survives URL-base resolution failure by rendering entries with the unavailable sentinel', async () => {
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', scoop: 'pr', createdAt: new Date().toISOString() },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const trayMod = await import('../../../src/scoops/tray-leader.js');
    const spy = vi.spyOn(trayMod, 'getLeaderStatusWithFallback').mockImplementation(() => {
      throw new Error('storage flake');
    });
    try {
      const result = await command.execute(['list'], {} as never);
      // The entry list is the load-bearing payload — must NOT be
      // discarded just because URL resolution threw.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('wh-1');
      expect(result.stdout).toContain('URL resolution failed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('webhook — extension-delegate leader (no node-server)', () => {
  afterEach(async () => {
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId(null);
    delete (globalThis as Record<string, unknown>).__slicc_lickManager;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('create is REFUSED (exit 1, honest message) when no tray session', async () => {
    vi.resetModules();
    vi.stubGlobal('chrome', { runtime: { connect: () => undefined } });
    stubSelfLocation('https://www.sliccy.ai/?slicc=leader&ext=abc');
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('abc'); // topology → extension-delegate (no node-server)

    const lm = buildLickManagerMock({ createWebhook: vi.fn() });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    // No setStatus + no localStorage shim → tray status is `inactive`.
    const { command } = await loadCommandAndTrayLeader();
    const result = await (command as any).execute(['create', '--scoop', 'pr'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('extension-leader mode');
    expect(result.stderr).toContain('"inactive"');
    expect(lm.createWebhook).not.toHaveBeenCalled();
  });

  it('create succeeds with the tray URL via the page-side (localStorage-shim) tray', async () => {
    vi.resetModules();
    vi.stubGlobal('chrome', { runtime: { connect: () => undefined } });
    stubSelfLocation('https://www.sliccy.ai/?slicc=leader&ext=abc');
    const { setExtensionDelegateId } = await import('../../../src/shell/proxied-fetch.js');
    setExtensionDelegateId('abc');
    const { LEADER_STATUS_STORAGE_KEY } = await import('../../../src/scoops/tray-leader.js');
    // Page-side leader tray: worker module global stays inactive; the status
    // lives only in the localStorage shim, which getLeaderStatusWithFallback reads.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) =>
        k === LEADER_STATUS_STORAGE_KEY
          ? JSON.stringify({ state: 'leader', session: SESSION, error: null })
          : null,
      setItem: () => {},
      removeItem: () => {},
    });

    const lm = buildLickManagerMock({
      createWebhook: vi
        .fn()
        .mockResolvedValue({ id: 'wh1', name: 'default', scoop: 'pr' } as WebhookEntry),
    });
    (globalThis as Record<string, unknown>).__slicc_lickManager = lm;

    const { command } = await loadCommandAndTrayLeader();
    const result = await (command as any).execute(['create', '--scoop', 'pr'], {} as never);

    expect(result.exitCode).toBe(0);
    expect(lm.createWebhook).toHaveBeenCalled();
    // SESSION.webhookUrl = 'https://hub.slicc.dev/webhook/abc' → per-id suffix.
    expect(result.stdout).toContain('https://hub.slicc.dev/webhook/abc/wh1');
    expect(result.stdout).not.toContain('sliccy.ai/webhooks');
  });
});
