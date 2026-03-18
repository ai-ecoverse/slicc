import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createTeleportCommand,
  parseTeleportArgs,
  setTeleportSendRequest,
  setTeleportBestFollower,
  setTeleportConnectedFollowers,
  setTeleportBrowserAPI,
} from './teleport-command.js';
import type { CookieTeleportCookie } from '../../scoops/tray-sync-protocol.js';
import type { BrowserAPI } from '../../cdp/index.js';

// ---------------------------------------------------------------------------
// parseTeleportArgs
// ---------------------------------------------------------------------------

describe('parseTeleportArgs', () => {
  it('returns help error for --help', () => {
    expect(parseTeleportArgs(['--help'])).toEqual({ error: '__help__' });
    expect(parseTeleportArgs(['-h'])).toEqual({ error: '__help__' });
  });

  it('parses no args (auto-select mode)', () => {
    const result = parseTeleportArgs([]);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  it('parses a specific runtime-id', () => {
    const result = parseTeleportArgs(['follower-abc']);
    expect(result).toEqual({ targetRuntimeId: 'follower-abc', url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  it('parses --list flag', () => {
    const result = parseTeleportArgs(['--list']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: true, reload: true });
  });

  it('parses -l shorthand', () => {
    const result = parseTeleportArgs(['-l']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: true, reload: true });
  });

  it('parses --no-reload flag', () => {
    const result = parseTeleportArgs(['--no-reload']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: false });
  });

  it('parses --reload explicitly', () => {
    const result = parseTeleportArgs(['--no-reload', '--reload']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  it('parses -r shorthand', () => {
    const result = parseTeleportArgs(['-r']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  it('errors on unknown flags', () => {
    const result = parseTeleportArgs(['--unknown']);
    expect(result).toEqual({ error: 'Unknown flag: --unknown' });
  });

  it('errors on too many positional args', () => {
    const result = parseTeleportArgs(['follower-a', 'follower-b']);
    expect(result).toEqual({ error: 'Expected at most 1 argument: <runtime-id>' });
  });

  it('combines runtime-id with flags', () => {
    const result = parseTeleportArgs(['follower-abc', '--no-reload']);
    expect(result).toEqual({ targetRuntimeId: 'follower-abc', url: undefined, catchPattern: undefined, catchNotPattern: undefined, list: false, reload: false });
  });

  it('parses --url flag', () => {
    const result = parseTeleportArgs(['--url', 'https://login.example.com']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: 'https://login.example.com', catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  it('combines --url with runtime-id', () => {
    const result = parseTeleportArgs(['follower-abc', '--url', 'https://auth.site.com']);
    expect(result).toEqual({ targetRuntimeId: 'follower-abc', url: 'https://auth.site.com', catchPattern: undefined, catchNotPattern: undefined, list: false, reload: true });
  });

  // --catch / --catch-not parsing tests
  it('parses --catch flag', () => {
    const result = parseTeleportArgs(['--url', 'https://example.com', '--catch', 'dashboard']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: 'https://example.com', catchPattern: 'dashboard', catchNotPattern: undefined, list: false, reload: true });
  });

  it('parses --catch-not flag', () => {
    const result = parseTeleportArgs(['--url', 'https://example.com', '--catch-not', 'login|okta']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: 'https://example.com', catchPattern: undefined, catchNotPattern: 'login|okta', list: false, reload: true });
  });

  it('errors when --catch and --catch-not are both provided', () => {
    const result = parseTeleportArgs(['--catch', 'foo', '--catch-not', 'bar']);
    expect(result).toEqual({ error: '--catch and --catch-not are mutually exclusive' });
  });

  it('errors on invalid regex for --catch', () => {
    const result = parseTeleportArgs(['--catch', '[invalid']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid regex');
  });

  it('errors on invalid regex for --catch-not', () => {
    const result = parseTeleportArgs(['--catch-not', '[invalid']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Invalid regex');
  });

  it('errors when --catch has no value', () => {
    const result = parseTeleportArgs(['--catch']);
    expect(result).toEqual({ error: '--catch requires a regex argument' });
  });

  it('errors when --catch-not has no value', () => {
    const result = parseTeleportArgs(['--catch-not']);
    expect(result).toEqual({ error: '--catch-not requires a regex argument' });
  });

  it('errors when --url has no value', () => {
    const result = parseTeleportArgs(['--url']);
    expect(result).toEqual({ error: '--url requires a URL argument' });
  });

  it('errors when --url is followed by a flag', () => {
    const result = parseTeleportArgs(['--url', '--no-reload']);
    expect(result).toEqual({ error: '--url requires a URL argument' });
  });

  // --timeout parsing tests
  it('parses --timeout flag', () => {
    const result = parseTeleportArgs(['--url', 'https://example.com', '--timeout', '60']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: 'https://example.com', catchPattern: undefined, catchNotPattern: undefined, timeout: 60, list: false, reload: true });
  });

  it('errors when --timeout has no value', () => {
    const result = parseTeleportArgs(['--timeout']);
    expect(result).toEqual({ error: '--timeout requires a number (seconds)' });
  });

  it('errors when --timeout is followed by a flag', () => {
    const result = parseTeleportArgs(['--timeout', '--no-reload']);
    expect(result).toEqual({ error: '--timeout requires a number (seconds)' });
  });

  it('errors when --timeout is not a positive number', () => {
    const result = parseTeleportArgs(['--timeout', '0']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('positive number');
  });

  it('errors when --timeout is negative', () => {
    const result = parseTeleportArgs(['--timeout', '-5']);
    // -5 starts with '-' so it's treated as a flag → "requires a number"
    expect(result).toEqual({ error: '--timeout requires a number (seconds)' });
  });

  it('errors when --timeout is not a number', () => {
    const result = parseTeleportArgs(['--timeout', 'abc']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('positive number');
  });

  it('parses --timeout without --url', () => {
    const result = parseTeleportArgs(['--timeout', '30']);
    expect(result).toEqual({ targetRuntimeId: undefined, url: undefined, catchPattern: undefined, catchNotPattern: undefined, timeout: 30, list: false, reload: true });
  });
});

// ---------------------------------------------------------------------------
// createTeleportCommand
// ---------------------------------------------------------------------------

describe('createTeleportCommand', () => {
  afterEach(() => {
    setTeleportSendRequest(null);
    setTeleportBestFollower(null);
    setTeleportConnectedFollowers(null);
    setTeleportBrowserAPI(null);
  });

  it('has the correct name', () => {
    expect(createTeleportCommand().name).toBe('teleport');
  });

  it('shows help with --help', async () => {
    const result = await createTeleportCommand().execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teleport — teleport cookies');
  });

  it('shows help with -h', async () => {
    const result = await createTeleportCommand().execute(['-h'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teleport — teleport cookies');
  });

  it('errors when not connected to a tray', async () => {
    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not connected to a tray');
  });

  it('--list errors when not connected to a tray', async () => {
    const result = await createTeleportCommand().execute(['--list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not connected to a tray');
  });

  it('--list shows connected followers', async () => {
    setTeleportConnectedFollowers(() => () => [
      { runtimeId: 'follower-abc', runtime: 'slicc-standalone', floatType: 'standalone', lastActivity: Date.now() - 5000 },
      { runtimeId: 'follower-def', runtime: 'slicc-extension', floatType: 'extension', lastActivity: Date.now() - 10000 },
    ]);

    const result = await createTeleportCommand().execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('follower-abc');
    expect(result.stdout).toContain('[standalone]');
    expect(result.stdout).toContain('follower-def');
    expect(result.stdout).toContain('[extension]');
  });

  it('--list shows no followers message', async () => {
    setTeleportConnectedFollowers(() => () => []);

    const result = await createTeleportCommand().execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No followers connected');
  });

  it('errors when no browser available', async () => {
    setTeleportSendRequest(() => () => Promise.resolve({ cookies: [] as CookieTeleportCookie[], timedOut: false }));

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no browser available');
  });

  it('errors when no best follower available (auto-select)', async () => {
    setTeleportSendRequest(() => () => Promise.resolve({ cookies: [] as CookieTeleportCookie[], timedOut: false }));
    setTeleportBrowserAPI(() => ({ listPages: vi.fn() }) as unknown as BrowserAPI);
    setTeleportBestFollower(() => () => null);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no followers connected');
  });

  it('teleports cookies from auto-selected follower', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'session', value: 'abc123', domain: '.example.com', path: '/',
        expires: -1, size: 50, httpOnly: true, secure: true, session: true,
      },
    ];

    const sendRequest = vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false });
    const sendCDP = vi.fn().mockResolvedValue({});
    const attachToPage = vi.fn().mockResolvedValue(undefined);
    const listPages = vi.fn().mockResolvedValue([
      { targetId: 'tab-1', title: 'Page', url: 'https://example.com', active: true },
    ]);

    setTeleportSendRequest(() => sendRequest);
    setTeleportBestFollower(() => () => ({ runtimeId: 'follower-best', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages,
      attachToPage,
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Teleported 1 cookie(s) from follower-best (1 .example.com)');
    expect(result.stdout).toContain('page reloaded');
    expect(sendRequest).toHaveBeenCalledWith('follower-best', undefined, undefined, undefined, undefined);
    expect(sendCDP).toHaveBeenCalledWith('Network.setCookies', { cookies: fakeCookies });
    expect(sendCDP).toHaveBeenCalledWith('Page.reload', {});
  });

  it('navigates to finalUrl when present (instead of Page.reload)', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'session', value: 'abc123', domain: '.example.com', path: '/',
        expires: -1, size: 50, httpOnly: true, secure: true, session: true,
      },
    ];

    const sendRequest = vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false, finalUrl: 'https://app.navan.com/dashboard' });
    const sendCDP = vi.fn().mockResolvedValue({});

    setTeleportSendRequest(() => sendRequest);
    setTeleportBestFollower(() => () => ({ runtimeId: 'follower-best', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 'tab-1', title: 'Page', url: 'https://example.com', active: true }]),
      attachToPage: vi.fn(),
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(1 .example.com)');
    expect(result.stdout).toContain('(navigated to https://app.navan.com/dashboard)');
    expect(result.stdout).not.toContain('page reloaded');
    expect(result.stdout).not.toContain('landed on');
    expect(sendCDP).toHaveBeenCalledWith('Page.navigate', { url: 'https://app.navan.com/dashboard' });
    expect(sendCDP).not.toHaveBeenCalledWith('Page.reload', {});
  });

  it('includes per-domain cookie breakdown sorted by count descending', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      { name: 'a', value: '1', domain: 'login.navan.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'b', value: '2', domain: '.navan.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'c', value: '3', domain: 'login.navan.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'd', value: '4', domain: 'adobe.okta.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'e', value: '5', domain: 'login.navan.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'f', value: '6', domain: '.navan.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
      { name: 'g', value: '7', domain: 'adobe.okta.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true },
    ];

    const sendRequest = vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false, finalUrl: 'https://app.navan.com/app/user2/' });
    const sendCDP = vi.fn().mockResolvedValue({});

    setTeleportSendRequest(() => sendRequest);
    setTeleportBestFollower(() => () => ({ runtimeId: 'follower-abc123', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 'tab-1', title: 'Page', url: 'https://example.com', active: true }]),
      attachToPage: vi.fn(),
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Teleported 7 cookie(s) from follower-abc123 (3 login.navan.com, 2 .navan.com, 2 adobe.okta.com) (navigated to https://app.navan.com/app/user2/)\n',
    );
  });

  it('teleports cookies from specific runtime-id', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'token', value: 'xyz', domain: '.app.com', path: '/',
        expires: 1700000000, size: 30, httpOnly: false, secure: true, session: false,
      },
    ];

    const sendRequest = vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false });
    const sendCDP = vi.fn().mockResolvedValue({});

    setTeleportSendRequest(() => sendRequest);
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 'tab-1', title: 'P', url: 'https://app.com' }]),
      attachToPage: vi.fn(),
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute(['follower-xyz'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(sendRequest).toHaveBeenCalledWith('follower-xyz', undefined, undefined, undefined, undefined);
    expect(sendCDP).toHaveBeenCalledWith('Network.setCookies', { cookies: fakeCookies });
  });

  it('skips reload with --no-reload', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'a', value: 'b', domain: '.x.com', path: '/',
        expires: -1, size: 10, httpOnly: false, secure: false, session: true,
      },
    ];

    const sendCDP = vi.fn().mockResolvedValue({});

    setTeleportSendRequest(() => vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false }));
    setTeleportBestFollower(() => () => ({ runtimeId: 'f1', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 't1', title: 'T', url: 'https://x.com' }]),
      attachToPage: vi.fn(),
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute(['--no-reload'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('page reloaded');
    // setCookies is called but Page.reload is not
    expect(sendCDP).toHaveBeenCalledWith('Network.setCookies', { cookies: fakeCookies });
    expect(sendCDP).not.toHaveBeenCalledWith('Page.reload', {});
  });

  it('handles no cookies from remote', async () => {
    setTeleportSendRequest(() => vi.fn().mockResolvedValue({ cookies: [], timedOut: false }));
    setTeleportBestFollower(() => () => ({ runtimeId: 'f1', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 't1', title: 'T', url: 'https://x.com' }]),
      attachToPage: vi.fn(),
      sendCDP: vi.fn(),
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No cookies on runtime');
  });

  it('handles errors from sendCookieTeleportRequest', async () => {
    setTeleportSendRequest(() => vi.fn().mockRejectedValue(new Error('Runtime not connected')));
    setTeleportBestFollower(() => () => ({ runtimeId: 'f1', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 't1', title: 'T', url: 'https://x.com' }]),
      attachToPage: vi.fn(),
      sendCDP: vi.fn(),
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Runtime not connected');
  });

  it('passes --url to sendCookieTeleportRequest', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'auth', value: 'tok', domain: '.example.com', path: '/',
        expires: -1, size: 20, httpOnly: true, secure: true, session: true,
      },
    ];

    const sendRequest = vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false });
    const sendCDP = vi.fn().mockResolvedValue({});

    setTeleportSendRequest(() => sendRequest);
    setTeleportBestFollower(() => () => ({ runtimeId: 'f1', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([{ targetId: 't1', title: 'T', url: 'https://x.com', active: true }]),
      attachToPage: vi.fn(),
      sendCDP,
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute(['--url', 'https://login.example.com'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(sendRequest).toHaveBeenCalledWith('f1', 'https://login.example.com', undefined, undefined, 300_000);
  });

  it('errors when no local tabs available', async () => {
    const fakeCookies: CookieTeleportCookie[] = [
      {
        name: 'a', value: 'b', domain: '.x.com', path: '/',
        expires: -1, size: 10, httpOnly: false, secure: false, session: true,
      },
    ];

    setTeleportSendRequest(() => vi.fn().mockResolvedValue({ cookies: fakeCookies, timedOut: false }));
    setTeleportBestFollower(() => () => ({ runtimeId: 'f1', bootstrapId: 'b1', floatType: 'standalone' as const }));
    setTeleportBrowserAPI(() => ({
      listPages: vi.fn().mockResolvedValue([]),
      attachToPage: vi.fn(),
      sendCDP: vi.fn(),
      getTransport: vi.fn(),
    }) as unknown as BrowserAPI);

    const result = await createTeleportCommand().execute([], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no local tabs available');
  });
});
