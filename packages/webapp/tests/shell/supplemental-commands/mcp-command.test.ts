// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom historically exposed `localStorage` but on Node >= 25 it falls
// through to a node-native stub that throws. Match the pattern in
// `tests/ui/telemetry.test.ts` and stub a plain in-memory shim.
const lsBacking: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => lsBacking[k] ?? null,
  setItem: (k: string, v: string) => {
    lsBacking[k] = v;
  },
  removeItem: (k: string) => {
    delete lsBacking[k];
  },
  clear: () => {
    for (const k of Object.keys(lsBacking)) delete lsBacking[k];
  },
};
vi.stubGlobal('localStorage', localStorageStub);

// Hoisted spy used by the partial mock below so per-test overrides take
// effect against the *same* function reference the production code imports.
const { mockGetOAuthPageOrigin } = vi.hoisted(() => ({
  mockGetOAuthPageOrigin: vi.fn<() => Promise<{ origin: string; href: string }>>(),
}));
vi.mock('../../../src/providers/oauth-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/providers/oauth-service.js')>();
  return { ...orig, getOAuthPageOrigin: mockGetOAuthPageOrigin };
});

import { GLOBAL_FS_DB_NAME } from '../../../src/fs/global-db.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  unregisterProviderConfig,
} from '../../../src/providers/index.js';
import type { FetchLike } from '../../../src/shell/mcp/oauth.js';
import {
  _testOnly_resetMcpProviderState,
  mcpProviderId,
  registerMcpProvider,
} from '../../../src/shell/mcp/provider.js';
import {
  _testOnly_resetStoreCache,
  readServersFile,
  setServer,
} from '../../../src/shell/mcp/store.js';
import type { McpFetchLike } from '../../../src/shell/mcp/types.js';
import {
  aliasContent,
  coerceArgsBySchema,
  createMcpCommand,
  extractTimeoutFlag,
  renderToolResult,
} from '../../../src/shell/supplemental-commands/mcp-command.js';

type RpcBody = {
  jsonrpc?: string;
  id: number;
  method: string;
  params?: unknown;
};

interface MockResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: unknown;
}

interface MockServerOptions {
  authRequired?: boolean;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  apps?: Array<{ name: string; title?: string; templateUri?: string }>;
  toolResults?: Record<string, unknown>;
  sessionId?: string;
  /** When set, the server expects this Bearer token to skip the 401. */
  expectedToken?: string;
}

function makeMockMcpFetch(opts: MockServerOptions): {
  fetch: McpFetchLike;
  calls: Array<{ url: string; method: string; body?: RpcBody; auth?: string }>;
} {
  const calls: Array<{ url: string; method: string; body?: RpcBody; auth?: string }> = [];
  const encode = (obj: unknown): Uint8Array =>
    new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj));

  const fetch: McpFetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    let body: RpcBody | undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string) as RpcBody;
      } catch {
        /* ignore non-JSON */
      }
    }
    const auth =
      init?.headers && typeof init.headers === 'object'
        ? (init.headers as Record<string, string>)['Authorization']
        : undefined;
    calls.push({ url, method, body, auth });

    const id = body?.id ?? 1;
    if (opts.authRequired) {
      if (!auth || (opts.expectedToken && auth !== `Bearer ${opts.expectedToken}`)) {
        return {
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://server.test/.well-known/oauth-protected-resource"',
          },
          body: encode(''),
        };
      }
    }

    const respond = (result: unknown): MockResponse => ({
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
      },
      body: { jsonrpc: '2.0', id, result },
    });

    let resp: MockResponse;
    switch (body?.method) {
      case 'initialize':
        resp = respond({ protocolVersion: '2025-06-18', capabilities: {} });
        break;
      case 'tools/list':
        resp = respond({ tools: opts.tools ?? [] });
        break;
      case 'apps/list':
        resp = respond({ apps: opts.apps ?? [] });
        break;
      case 'tools/call': {
        const params = body.params as { name: string; arguments?: unknown };
        const result =
          opts.toolResults?.[params.name] ??
          ({
            content: [{ type: 'text', text: `called ${params.name}` }],
          } as unknown);
        resp = respond(result);
        break;
      }
      default:
        resp = respond({ ok: true });
    }
    return {
      status: resp.status,
      statusText: resp.statusText ?? 'OK',
      headers: resp.headers ?? {},
      body: encode(resp.body),
    };
  };
  return { fetch, calls };
}

function makeMockOAuthFetch(): FetchLike {
  return async (url, init) => {
    const json = (payload: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(payload),
      json: async () => payload,
      headers: { get: () => null },
    });
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return json({
        authorization_servers: ['https://auth.test'],
        scopes_supported: ['mcp:tools'],
      });
    }
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://auth.test',
        authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token',
        registration_endpoint: 'https://auth.test/register',
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (url === 'https://auth.test/register') {
      return json({ client_id: 'test-client-abc' });
    }
    if (url === 'https://auth.test/token') {
      const params = new URLSearchParams(init?.body ?? '');
      if (params.get('grant_type') === 'refresh_token') {
        return json({
          access_token: 'rotated-token',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return json({
        access_token: 'mcp-access-token',
        refresh_token: 'mcp-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'mcp:tools',
      });
    }
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
      json: async () => ({}),
      headers: { get: () => null },
    };
  };
}

const stubLauncher = async (authorizeUrl: string): Promise<string | null> => {
  const u = new URL(authorizeUrl);
  return `http://127.0.0.1:5710/auth/callback?code=test-code&state=${u.searchParams.get('state')}`;
};

async function wipeGlobalFs(): Promise<void> {
  await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME, wipe: true });
}

const runCmd = async (
  args: string[],
  deps: Parameters<typeof createMcpCommand>[0] = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const cmd = createMcpCommand(deps);
  return cmd.execute(args, {} as never);
};

describe('mcp command — top level', () => {
  it('shows help with no args', async () => {
    const r = await runCmd([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: mcp <command>');
    expect(r.stdout).toContain('add <url> <name>');
  });

  it('shows help with --help', async () => {
    const r = await runCmd(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Commands:');
  });

  it('rejects unknown subcommand', async () => {
    const r = await runCmd(['bogus']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown subcommand "bogus"');
  });
});

describe('coerceArgsBySchema', () => {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string' },
      days: { type: 'integer' },
      temp: { type: 'number' },
      verbose: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['city'],
  };

  it('coerces primitives by type', () => {
    const r = coerceArgsBySchema(
      ['--city', 'NYC', '--days', '7', '--temp', '12.5', '--verbose'],
      schema
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ city: 'NYC', days: 7, temp: 12.5, verbose: true });
  });

  it('supports --flag=value form', () => {
    const r = coerceArgsBySchema(['--city=Berlin', '--days=3'], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ city: 'Berlin', days: 3 });
  });

  it('accumulates repeated array flags', () => {
    const r = coerceArgsBySchema(['--city', 'A', '--tags', 'one', '--tags', 'two'], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tags).toEqual(['one', 'two']);
  });

  it('rejects missing required flag', () => {
    const r = coerceArgsBySchema(['--days', '3'], schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('missing required flag --city');
  });

  it('rejects bad integer', () => {
    const r = coerceArgsBySchema(['--city', 'X', '--days', 'abc'], schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('expected integer');
  });

  it('treats bare --flag as true only when schema says boolean', () => {
    const r = coerceArgsBySchema(['--city', 'X', '--verbose'], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verbose).toBe(true);
  });
});

describe('renderToolResult', () => {
  it('joins text content', () => {
    const r = renderToolResult({ content: [{ type: 'text', text: 'hello' }] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello\n');
  });
  it('summarizes images/resources', () => {
    const r = renderToolResult({
      content: [
        { type: 'image', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x.txt' } },
      ],
    });
    expect(r.stdout).toContain('[image: image/png]');
    expect(r.stdout).toContain('[resource: file:///x.txt]');
  });
  it('surfaces isError as exit 1', () => {
    const r = renderToolResult({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('boom');
  });
});

describe('aliasContent', () => {
  it('writes a valid shim that forwards to mcp invoke', () => {
    const content = aliasContent('weather');
    expect(content).toContain("'mcp', 'invoke', \"weather\"");
    expect(content).toContain('await exec(cmd)');
    expect(content).toContain('process.exit(r.exitCode');
    // Args must be pulled from `process.argv.slice(2)` — the JS realm exposes
    // script argv via `processShim.argv`, not via a bare `args` global.
    expect(content).toContain('process.argv.slice(2)');
    // Regression guard: a future revert to the old `typeof args` reference
    // would silently break every alias by feeding `mcp invoke` no arguments.
    expect(content).not.toMatch(/typeof\s+args\b/);
  });

  it('does not call a bare top-level `exit(` (only process.exit is in scope)', () => {
    const content = aliasContent('weather');
    // The realm exposes `exit` only via `process.exit` — a bare `exit(...)`
    // call would throw `ReferenceError: exit is not defined`. Match `exit(`
    // only when it is not preceded by `process.` / `.` / identifier chars so
    // the legitimate `process.exit(...)` call does not trip the assertion.
    expect(content).not.toMatch(/(^|[^A-Za-z0-9_.])exit\(/);
  });
});

describe('mcp add / list / delete / invoke / refresh (integration)', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    // Default: mimic the in-page path so the OAuth-required tests keep
    // resolving a valid redirect URI without needing a panel-RPC bridge.
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    // Let LightningFS finish its debounced superblock write.
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('add: stores entry + writes alias for an unauthenticated server', async () => {
    const { fetch } = makeMockMcpFetch({
      tools: [
        {
          name: 'echo',
          description: 'Echo a string',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
      apps: [{ name: 'demo-app', title: 'Demo App' }],
      sessionId: 'sess-1',
    });

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added MCP server "demo"');
    expect(r.stdout).toContain('tools: 1');
    expect(r.stdout).toContain('auth:  none');

    const file = await readServersFile();
    expect(file.servers.demo.url).toBe('https://server.test/sse');
    // `sessionId` MUST NOT be persisted — sessions are per-process on the
    // server and re-sending one on the next `initialize` is a protocol
    // violation (MCP Streamable-HTTP).
    expect(file.servers.demo.sessionId).toBeUndefined();
    expect(file.servers.demo.tools).toEqual([
      {
        name: 'echo',
        description: 'Echo a string',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
    ]);
    expect(file.servers.demo.auth).toBeUndefined();

    // Alias shim written
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists('/workspace/.mcp/aliases/demo.jsh')).toBe(true);
  });

  it('add: rejects duplicate name', async () => {
    const { fetch } = makeMockMcpFetch({});
    const first = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
    });
    expect(first.exitCode).toBe(0);

    const second = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
    });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('already exists');
  });

  it('add: validates url and name', async () => {
    const badUrl = await runCmd(['add', 'not-a-url', 'demo']);
    expect(badUrl.exitCode).toBe(1);
    expect(badUrl.stderr).toContain('invalid URL');

    const badName = await runCmd(['add', 'https://server.test/sse', '1bad']);
    expect(badName.exitCode).toBe(1);
    expect(badName.stderr).toContain('invalid name');
  });

  it('add: runs OAuth flow on 401 and persists auth block', async () => {
    const { fetch } = makeMockMcpFetch({
      authRequired: true,
      expectedToken: 'mcp-access-token',
      tools: [{ name: 'foo' }],
    });
    const oauthFetch = makeMockOAuthFetch();

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      oauthFetchImpl: oauthFetch,
      oauthLauncher: stubLauncher,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('auth:  oauth (provider mcp:demo)');

    const file = await readServersFile();
    expect(file.servers.demo.auth?.clientId).toBe('test-client-abc');
    expect(file.servers.demo.auth?.providerId).toBe('mcp:demo');
    expect(file.servers.demo.auth?.authorizationServer).toBe('https://auth.test');

    // Provider was registered immediately
    expect(getRegisteredProviderConfig(mcpProviderId('demo'))).toBeDefined();
    expect(getRegisteredProviderIds()).toContain(mcpProviderId('demo'));

    // Account persisted to localStorage
    const accounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
    const acct = accounts.find((a: { providerId: string }) => a.providerId === 'mcp:demo');
    expect(acct.accessToken).toBe('mcp-access-token');
    expect(acct.refreshToken).toBe('mcp-refresh-token');
  });

  it('add: uses page-origin redirect URI when not running as a Chrome extension', async () => {
    // CLI / standalone webapp path — the launcher captures the redirect
    // on the page origin, so the URI registered with the AS must be
    // `<origin>/auth/callback`.
    const { fetch } = makeMockMcpFetch({
      authRequired: true,
      expectedToken: 'mcp-access-token',
      tools: [{ name: 'foo' }],
    });
    const oauthFetch = makeMockOAuthFetch();
    let capturedAuthorizeUrl = '';
    const captureLauncher = async (authorizeUrl: string): Promise<string | null> => {
      capturedAuthorizeUrl = authorizeUrl;
      const u = new URL(authorizeUrl);
      return `${u.searchParams.get('redirect_uri')}?code=test-code&state=${u.searchParams.get('state')}`;
    };

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      oauthFetchImpl: oauthFetch,
      oauthLauncher: captureLauncher,
    });
    expect(r.exitCode).toBe(0);
    const redirect = new URL(capturedAuthorizeUrl).searchParams.get('redirect_uri');
    expect(redirect).toBe(`${window.location.origin}/auth/callback`);
    expect(redirect).not.toMatch(/chromiumapp\.org/);
  });

  it('add: uses chromiumapp.org redirect URI when running as a Chrome extension', async () => {
    // Extension offscreen path — `chrome.identity.launchWebAuthFlow` only
    // captures redirects matching `<extension-id>.chromiumapp.org`, so
    // the URI registered with the AS must match.
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
      // `identity.getRedirectURL` is omitted so the production code
      // exercises the deterministic `<id>.chromiumapp.org` fallback.
      identity: undefined,
    };
    try {
      const { fetch } = makeMockMcpFetch({
        authRequired: true,
        expectedToken: 'mcp-access-token',
        tools: [{ name: 'foo' }],
      });
      const oauthFetch = makeMockOAuthFetch();
      let capturedAuthorizeUrl = '';
      const captureLauncher = async (authorizeUrl: string): Promise<string | null> => {
        capturedAuthorizeUrl = authorizeUrl;
        const u = new URL(authorizeUrl);
        return `${u.searchParams.get('redirect_uri')}?code=test-code&state=${u.searchParams.get('state')}`;
      };

      const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
        fetchImpl: fetch,
        oauthFetchImpl: oauthFetch,
        oauthLauncher: captureLauncher,
      });
      expect(r.exitCode).toBe(0);
      const redirect = new URL(capturedAuthorizeUrl).searchParams.get('redirect_uri');
      expect(redirect).toBe(
        'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/mcp-callback'
      );
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as any).chrome;
      } else {
        (globalThis as any).chrome = originalChrome;
      }
    }
  });

  it('list: empty + populated output', async () => {
    const empty = await runCmd(['list']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain('No MCP servers configured');

    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [{ name: 'a' }, { name: 'b' }],
      apps: [{ name: 'x' }],
      addedAt: '2026-05-20T10:00:00.000Z',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
      },
    });

    const filled = await runCmd(['list']);
    expect(filled.exitCode).toBe(0);
    expect(filled.stdout).toContain('NAME');
    expect(filled.stdout).toContain('demo');
    expect(filled.stdout).toContain('yes');
    expect(filled.stdout).toContain('2026-05-20');
  });
});

describe('mcp invoke / delete / refresh', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('invoke with no tool lists tools', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [{ name: 'echo', description: 'Echo a string' }],
    });
    const { fetch } = makeMockMcpFetch({
      tools: [{ name: 'echo', description: 'Echo a string' }],
    });
    const r = await runCmd(['invoke', 'demo'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('MCP server "demo"');
    expect(r.stdout).toContain('echo');
    expect(r.stdout).toContain('Echo a string');
  });

  it('invoke tool --help renders flags from cached inputSchema', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'weather',
          description: 'Get the weather',
          inputSchema: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
              days: { type: 'integer', description: 'Forecast days' },
            },
            required: ['city'],
          },
        },
      ],
    });
    const r = await runCmd(['invoke', 'demo', 'weather', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: demo weather');
    expect(r.stdout).toContain('--city <string>');
    expect(r.stdout).toContain('--days <integer>');
    expect(r.stdout).toContain('City name');
    expect(r.stdout).toContain('(required)');
  });

  it('invoke happy-path returns concatenated text content', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });
    const { fetch, calls } = makeMockMcpFetch({
      toolResults: {
        echo: { content: [{ type: 'text', text: 'pong: hi' }] },
      },
    });
    const r = await runCmd(['invoke', 'demo', 'echo', '--msg', 'hi'], {
      fetchImpl: fetch,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('pong: hi\n');
    const callBody = calls.find((c) => c.body?.method === 'tools/call')?.body;
    expect(callBody?.params).toEqual({ name: 'echo', arguments: { msg: 'hi' } });
  });

  it('invoke unknown tool errors out', async () => {
    await setServer('demo', { url: 'https://server.test/sse', tools: [] });
    const r = await runCmd(['invoke', 'demo', 'nope']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown tool "nope"');
  });

  it('invoke surfaces tool isError as exit 1', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [{ name: 'fail', inputSchema: { type: 'object', properties: {} } }],
    });
    const { fetch } = makeMockMcpFetch({
      toolResults: {
        fail: {
          isError: true,
          content: [{ type: 'text', text: 'something broke' }],
        },
      },
    });
    const r = await runCmd(['invoke', 'demo', 'fail'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('something broke');
  });

  it('invoke unknown server errors out', async () => {
    const r = await runCmd(['invoke', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown server "ghost"');
  });

  it('invoke does NOT pass a stale persisted sessionId to McpClient (initialize must be Mcp-Session-Id-free)', async () => {
    // Seed an entry with a stale sessionId — historically `cmdInvoke` would
    // thread this into the McpClient constructor, which then sent it on the
    // `initialize` request and triggered a protocol violation.
    await setServer('demo', {
      url: 'https://server.test/sse',
      sessionId: 'stale-from-old-version',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });

    const calls: Array<{
      method?: string;
      mcpSessionId?: string;
    }> = [];
    const fetchImpl: McpFetchLike = async (_url, init) => {
      let body: RpcBody | undefined;
      try {
        body = JSON.parse((init?.body as string) ?? '{}') as RpcBody;
      } catch {
        /* ignore */
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method: body?.method, mcpSessionId: headers['Mcp-Session-Id'] });
      const id = body?.id ?? 1;
      const result =
        body?.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'pong' }] }
          : body?.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {} }
            : { ok: true };
      const respHeaders: Record<string, string> =
        body?.method === 'initialize'
          ? { 'content-type': 'application/json', 'Mcp-Session-Id': 'fresh-sess' }
          : { 'content-type': 'application/json' };
      return {
        status: 200,
        statusText: 'OK',
        headers: respHeaders,
        body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result })),
      };
    };

    const r = await runCmd(['invoke', 'demo', 'echo', '--msg', 'hi'], { fetchImpl });
    expect(r.exitCode).toBe(0);

    const initCall = calls.find((c) => c.method === 'initialize');
    const toolCall = calls.find((c) => c.method === 'tools/call');
    expect(initCall?.mcpSessionId).toBeUndefined();
    // The freshly issued session id (from the initialize response) is echoed
    // on the subsequent tools/call within the same client instance.
    expect(toolCall?.mcpSessionId).toBe('fresh-sess');
  });

  it('add materializes apps with templateUri as sprinkles under /workspace/.mcp/sprinkles/<name>', async () => {
    const { fetch } = makeMockMcpFetch({
      tools: [],
      apps: [
        { name: 'forecast', title: 'Forecast', templateUri: 'https://example.test/f.html' },
        { name: 'no-template' },
      ],
    });
    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('apps: 2 (1 sprinkle)');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    expect(await fs.exists('/workspace/.mcp/sprinkles/demo/forecast.shtml')).toBe(true);
    const content = (await fs.readFile('/workspace/.mcp/sprinkles/demo/forecast.shtml', {
      encoding: 'utf-8',
    })) as string;
    expect(content).toContain('src="https://example.test/f.html"');
    expect(content).toContain('window.mcpInvoke');
  });

  it('refresh re-fetches tools/apps and updates lastRefreshedAt', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [],
      apps: [],
      lastRefreshedAt: '2020-01-01T00:00:00.000Z',
    });
    const { fetch } = makeMockMcpFetch({
      tools: [{ name: 'a' }, { name: 'b' }],
      apps: [{ name: 'x' }],
    });
    const r = await runCmd(['refresh', 'demo'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('tools: 2');
    expect(r.stdout).toContain('apps: 1');
    const file = await readServersFile();
    expect(file.servers.demo.tools?.length).toBe(2);
    expect(file.servers.demo.lastRefreshedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('delete: cleans server, alias, sprinkles, account, provider', async () => {
    // Seed: a fully-populated server with auth + alias + sprinkles dir + account
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
      },
    });
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp/aliases', { recursive: true });
    await fs.writeFile('/workspace/.mcp/aliases/demo.jsh', aliasContent('demo'));
    await fs.mkdir('/workspace/.mcp/sprinkles/demo', { recursive: true });
    await fs.writeFile('/workspace/.mcp/sprinkles/demo/info.txt', 'hi');
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'mcp:demo',
          apiKey: '',
          accessToken: 'tok',
        },
      ])
    );

    const r = await runCmd(['delete', 'demo']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Removed MCP server "demo"');
    expect(r.stdout).toContain('servers.json: removed');
    expect(r.stdout).toContain('oauth:        removed');

    expect(await fs.exists('/workspace/.mcp/aliases/demo.jsh')).toBe(false);
    expect(await fs.exists('/workspace/.mcp/sprinkles/demo')).toBe(false);

    const accounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
    expect(
      accounts.find((a: { providerId: string }) => a.providerId === 'mcp:demo')
    ).toBeUndefined();

    const file = await readServersFile();
    expect(file.servers.demo).toBeUndefined();
  });

  it('delete: returns error when nothing exists', async () => {
    const r = await runCmd(['delete', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no server, alias, or account found');
  });

  it('lazy-registers providers after a simulated reload via mcp list', async () => {
    // Seed servers.json directly (as if persisted by a previous session)
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
      },
    });
    // Simulate "reload": clear in-session caches but keep VFS + accounts.
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    expect(getRegisteredProviderConfig(mcpProviderId('demo'))).toBeUndefined();

    const r = await runCmd(['list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('demo');
    // After the list call, the provider must be visible in the registry.
    expect(getRegisteredProviderConfig(mcpProviderId('demo'))).toBeDefined();
    expect(getRegisteredProviderIds()).toContain(mcpProviderId('demo'));
  });
});

describe('mcp add: defaultRedirectUri via getOAuthPageOrigin', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('resolves redirect_uri from getOAuthPageOrigin and threads it through DCR + authorize + token exchange', async () => {
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: 'http://localhost:5711',
      href: 'http://localhost:5711/',
    });

    // Capture the registration body so we can verify the DCR redirect URI.
    let registeredRedirectUris: string[] | null = null;
    // Capture the token-exchange body so we can verify the exchange redirect URI.
    let exchangeRedirectUri: string | null = null;
    // Capture the URL the launcher saw so we can verify the authorize redirect_uri.
    let capturedAuthorizeUrl: string | null = null;

    const oauthFetch: FetchLike = async (url, init) => {
      const json = (payload: unknown) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(payload),
        json: async () => payload,
        headers: { get: () => null },
      });
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return json({
          authorization_servers: ['https://auth.test'],
          scopes_supported: ['mcp:tools'],
        });
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return json({
          issuer: 'https://auth.test',
          authorization_endpoint: 'https://auth.test/authorize',
          token_endpoint: 'https://auth.test/token',
          registration_endpoint: 'https://auth.test/register',
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        });
      }
      if (url === 'https://auth.test/register') {
        const body = JSON.parse((init?.body as string) || '{}') as {
          redirect_uris?: string[];
        };
        registeredRedirectUris = body.redirect_uris ?? null;
        return json({ client_id: 'test-client-abc' });
      }
      if (url === 'https://auth.test/token') {
        const params = new URLSearchParams((init?.body as string) ?? '');
        if (params.get('grant_type') === 'authorization_code') {
          exchangeRedirectUri = params.get('redirect_uri');
        }
        return json({
          access_token: 'mcp-access-token',
          refresh_token: 'mcp-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'mcp:tools',
        });
      }
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
        json: async () => ({}),
        headers: { get: () => null },
      };
    };

    const capturingLauncher = async (authorizeUrl: string): Promise<string | null> => {
      capturedAuthorizeUrl = authorizeUrl;
      const u = new URL(authorizeUrl);
      const redirect = u.searchParams.get('redirect_uri') ?? '';
      const state = u.searchParams.get('state') ?? '';
      return `${redirect}?code=test-code&state=${state}`;
    };

    const { fetch } = makeMockMcpFetch({
      authRequired: true,
      expectedToken: 'mcp-access-token',
      tools: [{ name: 'foo' }],
    });

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      oauthFetchImpl: oauthFetch,
      oauthLauncher: capturingLauncher,
    });
    expect(r.exitCode).toBe(0);

    expect(mockGetOAuthPageOrigin).toHaveBeenCalled();
    const expected = 'http://localhost:5711/auth/callback';
    expect(registeredRedirectUris).toEqual([expected]);
    expect(capturedAuthorizeUrl).not.toBeNull();
    const authorizeParams = new URL(capturedAuthorizeUrl as unknown as string).searchParams;
    expect(authorizeParams.get('redirect_uri')).toBe(expected);
    expect(exchangeRedirectUri).toBe(expected);
  });

  it('surfaces a clear error when getOAuthPageOrigin rejects (panel-RPC unavailable)', async () => {
    mockGetOAuthPageOrigin.mockRejectedValue(
      new Error('OAuth from worker context requires the panel-RPC bridge (no page-info available)')
    );

    const { fetch } = makeMockMcpFetch({
      authRequired: true,
      tools: [{ name: 'foo' }],
    });

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      oauthFetchImpl: makeMockOAuthFetch(),
      oauthLauncher: stubLauncher,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('mcp add:');
    expect(r.stderr).toContain('panel-RPC');

    // No silent fallback to a hardcoded loopback URI.
    expect(r.stderr).not.toContain('127.0.0.1:5710');
    expect(r.stderr).not.toContain('localhost:5710');

    // Server should NOT have been persisted on failure.
    const file = await readServersFile();
    expect(file.servers.demo).toBeUndefined();
  });
});

describe('mcp add/delete: shared fs + scriptCatalog invalidation', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('add: invalidates the script catalog after writing the alias', async () => {
    const { fetch } = makeMockMcpFetch({
      tools: [{ name: 'echo' }],
      sessionId: 'sess-1',
    });
    const invalidateJsh = vi.fn();
    const scriptCatalog = { invalidateJsh } as unknown as NonNullable<
      Parameters<typeof createMcpCommand>[0]
    >['scriptCatalog'];

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      scriptCatalog,
    });
    expect(r.exitCode).toBe(0);
    // At minimum, the alias-write path must have invalidated the catalog.
    expect(invalidateJsh).toHaveBeenCalled();
  });

  it('delete: invalidates the script catalog after removing the alias', async () => {
    // Seed an existing server + alias.
    await setServer('demo', { url: 'https://server.test/sse' });
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.mkdir('/workspace/.mcp/aliases', { recursive: true });
    await fs.writeFile('/workspace/.mcp/aliases/demo.jsh', aliasContent('demo'));

    const invalidateJsh = vi.fn();
    const scriptCatalog = { invalidateJsh } as unknown as NonNullable<
      Parameters<typeof createMcpCommand>[0]
    >['scriptCatalog'];

    const r = await runCmd(['delete', 'demo'], { scriptCatalog });
    expect(r.exitCode).toBe(0);
    expect(invalidateJsh).toHaveBeenCalled();
  });

  it('add: writes the alias through the injected fs instance', async () => {
    const { fetch } = makeMockMcpFetch({
      tools: [{ name: 'echo' }],
      sessionId: 'sess-1',
    });
    // Use the global db so provider registration / store reads still see
    // the same persisted data, but inject this specific instance so we
    // can spy on its writeFile to prove the alias went through it (not
    // through a parallel `openGlobalFs()` instance).
    const injectedFs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    const writeSpy = vi.spyOn(injectedFs, 'writeFile');

    const r = await runCmd(['add', 'https://server.test/sse', 'demo'], {
      fetchImpl: fetch,
      fs: injectedFs,
    });
    expect(r.exitCode).toBe(0);

    const aliasWrite = writeSpy.mock.calls.find(([p]) => p === '/workspace/.mcp/aliases/demo.jsh');
    expect(aliasWrite).toBeDefined();
  });
});

describe('mcp search', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('alpha'));
    unregisterProviderConfig(mcpProviderId('beta'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('alpha'));
    unregisterProviderConfig(mcpProviderId('beta'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('search with no arg → stderr, exit 1', async () => {
    const r = await runCmd(['search']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('mcp search: expected <query>');
  });

  it('search --help → stdout, exit 0', async () => {
    const r = await runCmd(['search', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: mcp search');
  });

  it('search with no servers configured → "No MCP servers configured."', async () => {
    const r = await runCmd(['search', 'anything']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No MCP servers configured');
  });

  it('search with servers but no match → "No tools matched"', async () => {
    await setServer('alpha', {
      url: 'https://a.test/sse',
      tools: [{ name: 'echo', description: 'Echo a string' }],
    });
    const r = await runCmd(['search', 'foo']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('No tools matched "foo".\n');
  });

  it('search returns table with correct MATCH column values, sorted by server then tool', async () => {
    await setServer('beta', {
      url: 'https://b.test/sse',
      tools: [
        // Description-only hit ("bar" in the description).
        { name: 'unrelated', description: 'mentions bar somewhere' },
      ],
    });
    await setServer('alpha', {
      url: 'https://a.test/sse',
      tools: [
        // Name-only hit ("bar" in name).
        { name: 'bar_tool', description: 'Does things' },
        // Name+description hit.
        { name: 'open_bar', description: 'opens the bar' },
        // No-match — must NOT appear.
        { name: 'zzz', description: 'noise' },
      ],
    });

    const r = await runCmd(['search', 'bar']);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    // Header + 3 rows
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^SERVER\s+TOOL\s+DESCRIPTION\s+MATCH$/);
    // Sorted: alpha first (alphabetical), then by tool name within alpha;
    // beta's row last.
    expect(lines[1]).toContain('alpha');
    expect(lines[1]).toContain('bar_tool');
    expect(lines[1]).toMatch(/\sname$/);
    expect(lines[2]).toContain('alpha');
    expect(lines[2]).toContain('open_bar');
    expect(lines[2]).toContain('name+description');
    expect(lines[3]).toContain('beta');
    expect(lines[3]).toContain('unrelated');
    expect(lines[3]).toMatch(/\sdescription$/);
    expect(r.stdout).not.toContain('zzz');
  });

  it('search is case-insensitive', async () => {
    await setServer('alpha', {
      url: 'https://a.test/sse',
      tools: [{ name: 'list_secrets', description: 'Enumerates the vault' }],
    });
    const r = await runCmd(['search', 'SECRET']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('list_secrets');
    expect(r.stdout).toContain('alpha');
  });

  it('search truncates long descriptions to ~60 chars with an ellipsis suffix', async () => {
    const longDesc = 'banana '.repeat(40).trim(); // well over 60 chars
    await setServer('alpha', {
      url: 'https://a.test/sse',
      tools: [{ name: 'fruit', description: longDesc }],
    });
    const r = await runCmd(['search', 'banana']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('…');
    // The truncated description ends with the ellipsis and the full
    // description (which is far longer than 60 chars) is NOT present.
    expect(r.stdout).toContain('…');
    expect(r.stdout).not.toContain(longDesc);
  });

  it('search handles tools with no description (empty DESCRIPTION cell)', async () => {
    await setServer('alpha', {
      url: 'https://a.test/sse',
      tools: [{ name: 'plain_tool' }],
    });
    const r = await runCmd(['search', 'plain']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('plain_tool');
    expect(r.stdout).toMatch(/plain_tool\s+name/);
  });
});

describe('extractTimeoutFlag', () => {
  it('returns undefined timeout and unchanged args when --timeout is absent', () => {
    const r = extractTimeoutFlag(['--repo', 'trieloff/vault', '--name', 'X']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.remaining).toEqual(['--repo', 'trieloff/vault', '--name', 'X']);
  });

  it('consumes `--timeout 90` from the middle of the args and converts to ms', () => {
    const r = extractTimeoutFlag(['--repo', 'x', '--timeout', '90', '--name', 'Y']);
    expect(r.timeoutMs).toBe(90_000);
    expect(r.warnings).toEqual([]);
    expect(r.remaining).toEqual(['--repo', 'x', '--name', 'Y']);
  });

  it('consumes the `--timeout=90` inline form', () => {
    const r = extractTimeoutFlag(['--timeout=45', '--repo', 'x']);
    expect(r.timeoutMs).toBe(45_000);
    expect(r.warnings).toEqual([]);
    expect(r.remaining).toEqual(['--repo', 'x']);
  });

  it('warns and falls back when --timeout is 0', () => {
    const r = extractTimeoutFlag(['--timeout', '0', '--repo', 'x']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/invalid --timeout value "0"/);
    expect(r.remaining).toEqual(['--repo', 'x']);
  });

  it('warns and falls back when --timeout is negative', () => {
    const r = extractTimeoutFlag(['--timeout', '-5']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/invalid --timeout value "-5"/);
    expect(r.remaining).toEqual([]);
  });

  it('warns and falls back when --timeout is non-numeric', () => {
    const r = extractTimeoutFlag(['--timeout', 'abc', '--repo', 'x']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/invalid --timeout value "abc"/);
    expect(r.remaining).toEqual(['--repo', 'x']);
  });

  it('warns and falls back when --timeout has no value (end of args)', () => {
    const r = extractTimeoutFlag(['--repo', 'x', '--timeout']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/--timeout requires a value/);
    expect(r.remaining).toEqual(['--repo', 'x']);
  });

  it('warns and falls back when --timeout is followed by another flag', () => {
    const r = extractTimeoutFlag(['--timeout', '--repo', 'x']);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/--timeout requires a value/);
    // The trailing --repo x is preserved as tool args, NOT consumed as the
    // timeout value.
    expect(r.remaining).toEqual(['--repo', 'x']);
  });
});

describe('mcp invoke --timeout flag (integration)', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('invoke help text mentions --timeout', async () => {
    const r = await runCmd(['invoke', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--timeout <seconds>');
    expect(r.stdout).toContain('default 60s');
  });

  it('strips --timeout from args so it never reaches the tool-args parser', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });
    const { fetch, calls } = makeMockMcpFetch({
      toolResults: { echo: { content: [{ type: 'text', text: 'ok' }] } },
    });
    const r = await runCmd(['invoke', 'demo', 'echo', '--timeout', '90', '--msg', 'hi'], {
      fetchImpl: fetch,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const toolsCall = calls.find((c) => c.body?.method === 'tools/call');
    // Only the real tool arg made it through — --timeout was consumed
    // upstream and is NOT visible as `{timeout: …}` on the JSON-RPC params.
    expect(toolsCall?.body?.params).toEqual({ name: 'echo', arguments: { msg: 'hi' } });
  });

  it('passes --timeout 1 through to McpClient and exits 124 on timeout', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [{ name: 'slow', inputSchema: { type: 'object', properties: {} } }],
    });
    // Fetch that never resolves — the only way the call returns is via the
    // McpClient timeout firing. If --timeout 1 wasn't threaded through, the
    // default (60s) would prevent the abort from firing within 1500ms.
    const fetchImpl: McpFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    vi.useFakeTimers();
    try {
      const p = runCmd(['invoke', 'demo', 'slow', '--timeout', '1'], { fetchImpl });
      await vi.advanceTimersByTimeAsync(1100);
      const r = await p;
      // Exit 124 distinguishes timeout from other failures (matches GNU timeout(1)).
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toMatch(/timed out after 1000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-timeout failures still exit 1 (unknown server)', async () => {
    const r = await runCmd(['invoke', 'no-such-server', 'whatever']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown server "no-such-server"');
  });

  it('non-timeout failures still exit 1 (unknown tool on known server)', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
    });
    const r = await runCmd(['invoke', 'demo', 'nope']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown tool "nope"');
  });

  it('non-timeout failures still exit 1 (JSON-RPC error from server)', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });
    // Fetch that returns a JSON-RPC error frame for tools/call (but initialize succeeds).
    const fetchImpl: McpFetchLike = async (_url, init) => {
      const body = init?.body
        ? (JSON.parse(init.body as string) as { id: number; method: string })
        : { id: 1, method: 'initialize' };
      const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
      if (body.method === 'tools/call') {
        return {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: encode({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32602, message: 'invalid params' },
          }),
        };
      }
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: encode({ jsonrpc: '2.0', id: body.id, result: {} }),
      };
    };
    const r = await runCmd(['invoke', 'demo', 'echo', '--msg', 'hi'], { fetchImpl });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/MCP RPC error -32602/);
  });

  it('warns to stderr but still succeeds when --timeout value is invalid (0)', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });
    const { fetch } = makeMockMcpFetch({
      toolResults: { echo: { content: [{ type: 'text', text: 'ok' }] } },
    });
    const r = await runCmd(['invoke', 'demo', 'echo', '--timeout', '0', '--msg', 'hi'], {
      fetchImpl: fetch,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('ok\n');
    expect(r.stderr).toMatch(/invalid --timeout value "0"/);
    expect(r.stderr).toMatch(/using default/);
  });

  it('warns to stderr but still succeeds when --timeout value is non-numeric', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      tools: [
        {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
          },
        },
      ],
    });
    const { fetch } = makeMockMcpFetch({
      toolResults: { echo: { content: [{ type: 'text', text: 'ok' }] } },
    });
    const r = await runCmd(['invoke', 'demo', 'echo', '--timeout', 'abc', '--msg', 'hi'], {
      fetchImpl: fetch,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/invalid --timeout value "abc"/);
  });
});

describe('mcp auth', () => {
  beforeEach(async () => {
    _testOnly_resetStoreCache();
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await wipeGlobalFs();
    localStorage.clear();
    mockGetOAuthPageOrigin.mockReset();
    mockGetOAuthPageOrigin.mockResolvedValue({
      origin: window.location.origin,
      href: window.location.href,
    });
  });

  afterEach(async () => {
    _testOnly_resetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('demo'));
    await new Promise((r) => setTimeout(r, 600));
    _testOnly_resetStoreCache();
  });

  it('--help lists --silent and --interactive flags', async () => {
    const r = await runCmd(['auth', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('usage: mcp auth');
    expect(r.stdout).toContain('--silent');
    expect(r.stdout).toContain('--interactive');
  });

  it('top-level help mentions the auth subcommand', async () => {
    const r = await runCmd(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\bauth\b/);
  });

  it('refresh --help mentions mcp auth for token refresh', async () => {
    const r = await runCmd(['refresh', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp auth');
  });

  it('errors on missing <name>', async () => {
    const r = await runCmd(['auth']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('mcp auth: expected <name>');
  });

  it('rejects --silent and --interactive together', async () => {
    const r = await runCmd(['auth', 'demo', '--silent', '--interactive']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('errors on unknown server with mcp list hint', async () => {
    const r = await runCmd(['auth', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown server "ghost"');
    expect(r.stderr).toContain('mcp list');
  });

  it('errors on server without an auth block', async () => {
    await setServer('demo', { url: 'https://server.test/sse' });
    const r = await runCmd(['auth', 'demo']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('does not use OAuth');
  });

  it('silent renewal: rotates token via refresh_token grant', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
    });
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'mcp:demo',
          apiKey: '',
          accessToken: 'stale-token',
          refreshToken: 'mcp-refresh-token',
          tokenExpiresAt: Date.now() - 60_000,
        },
      ])
    );
    // Pre-register with the mock OAuth fetch so `onSilentRenew` uses it
    // instead of the default `createProxiedFetch`. `ensureMcpProviderRegistered`
    // short-circuits when the provider is already in the session set.
    registerMcpProvider({
      name: 'demo',
      serverUrl: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
      fetchImpl: makeMockOAuthFetch(),
    });

    const r = await runCmd(['auth', 'demo']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Re-authenticated "demo"');
    expect(r.stdout).toContain('silent renewal');

    const accounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
    const acc = accounts.find((a: { providerId: string }) => a.providerId === 'mcp:demo');
    expect(acc?.accessToken).toBe('rotated-token');
  });

  it('--silent fails non-zero with retry hint when no refresh_token is stored', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
    });
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'mcp:demo',
          apiKey: '',
          accessToken: 'stale-token',
          // No refreshToken -> onSilentRenew returns null.
        },
      ])
    );
    registerMcpProvider({
      name: 'demo',
      serverUrl: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
      fetchImpl: makeMockOAuthFetch(),
    });

    const r = await runCmd(['auth', 'demo', '--silent']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('silent renewal');
    expect(r.stderr).toContain('retry without --silent');
  });

  it('falls back from silent to interactive when silent returns null', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
    });
    // No account at all -> getOAuthAccountInfo returns null -> silent
    // renewal returns null without throwing. Default flow must then run
    // the interactive popup path through the injected launcher.
    registerMcpProvider({
      name: 'demo',
      serverUrl: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
      fetchImpl: makeMockOAuthFetch(),
    });

    const r = await runCmd(['auth', 'demo'], { oauthLauncher: stubLauncher });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Re-authenticated "demo"');
    expect(r.stdout).toContain('interactive login');

    const accounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
    const acc = accounts.find((a: { providerId: string }) => a.providerId === 'mcp:demo');
    expect(acc?.accessToken).toBe('mcp-access-token');
  });

  it('--interactive skips silent renewal and runs the popup flow directly', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
    });
    // Seed a *valid* refresh token to prove --interactive bypasses it.
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'mcp:demo',
          apiKey: '',
          accessToken: 'stale-token',
          refreshToken: 'mcp-refresh-token',
          tokenExpiresAt: Date.now() - 60_000,
        },
      ])
    );
    registerMcpProvider({
      name: 'demo',
      serverUrl: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
      fetchImpl: makeMockOAuthFetch(),
    });

    const r = await runCmd(['auth', 'demo', '--interactive'], { oauthLauncher: stubLauncher });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('interactive login');
  });

  it('mcp refresh: emits a hint to run `mcp auth <name>` on a 401', async () => {
    await setServer('demo', {
      url: 'https://server.test/sse',
      auth: {
        providerId: 'mcp:demo',
        authorizationServer: 'https://auth.test',
        clientId: 'cid',
        scope: 'mcp:tools',
      },
    });
    // Server requires auth + no account is stored -> initialize gets 401.
    const { fetch } = makeMockMcpFetch({ authRequired: true });
    const r = await runCmd(['refresh', 'demo'], { fetchImpl: fetch });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('mcp auth demo');
    expect(r.stderr).toContain('401');
  });
});
