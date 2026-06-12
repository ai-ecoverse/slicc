/**
 * Integration test for `secret set` masked-env injection through a real
 * AlmostBashShell. Verifies that after `secret set K v`, the next exec sees the
 * masked value under `$K` (LLM-context parity), and that the value can be
 * piped via stdin.
 *
 * The CLI backend talks to `/api/secrets/*`; we mock `fetch` in-test so the
 * full pipeline (createSecretCommand → backend → setEnv hook → almost-bash-shell
 * pendingEnvWrites → bash env) is exercised end-to-end.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShell } from '../../src/shell/almost-bash-shell.js';

interface SessionEntry {
  name: string;
  value: string;
  domains: string[];
}

function maskFor(value: string): string {
  // Test-only masker — must NOT include the raw value as a substring so the
  // "real value never leaks into env" assertion is meaningful.
  return `mskd-${value.length}-${value.charCodeAt(0)}`;
}

function installSecretApiFetchMock(session: Map<string, SessionEntry>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    const json = (data: unknown, ok = true, status = ok ? 200 : 400) =>
      ({
        ok,
        status,
        json: async () => data,
      }) as Response;

    if (url === '/api/secrets' && method === 'GET') return json([]);
    if (url === '/api/secrets/session' && method === 'GET') {
      return json([...session.values()].map((e) => ({ name: e.name, domains: e.domains })));
    }
    if (url === '/api/secrets/session' && method === 'POST') {
      session.set(body.name, { name: body.name, value: body.value, domains: body.domains });
      return json({ ok: true });
    }
    if (url === '/api/secrets' && method === 'POST') {
      session.set(body.name, { name: body.name, value: body.value, domains: body.domains });
      return json({ ok: true });
    }
    if (url === '/api/secrets/masked' && method === 'GET') {
      return json(
        [...session.values()].map((e) => ({
          name: e.name,
          maskedValue: maskFor(e.value),
          domains: e.domains,
        }))
      );
    }
    return json({ error: 'unhandled' }, false, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AlmostBashShell + secret set — masked-env injection (LLM-context parity)', () => {
  let fs: VirtualFS;
  let dbCounter = 0;
  let session: Map<string, SessionEntry>;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-almost-bash-shell-secret-${dbCounter++}`,
      wipe: true,
    });
    session = new Map();
    installSecretApiFetchMock(session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the masked value under $NAME after secret set, not the real value', async () => {
    const shell = new AlmostBashShell({ fs });

    const setRes = await shell.executeCommand('secret set K real-value --domain api.x.com');
    expect(setRes.exitCode).toBe(0);
    expect(setRes.stdout).toContain('Set session secret "K"');
    // Sanity: the real value is in the backend.
    expect(session.get('K')?.value).toBe('real-value');

    const echoRes = await shell.executeCommand('echo $K');
    expect(echoRes.exitCode).toBe(0);
    expect(echoRes.stdout.trim()).toBe(maskFor('real-value'));
    // The real value MUST NOT have been injected into the shell env.
    expect(echoRes.stdout).not.toContain('real-value');
  });

  it('accepts the value via stdin (echo v | secret set K2)', async () => {
    const shell = new AlmostBashShell({ fs });

    const setRes = await shell.executeCommand(
      'echo piped-value | secret set K2 --domain api.x.com'
    );
    expect(setRes.exitCode).toBe(0);
    // Trailing \n from `echo` must be stripped.
    expect(session.get('K2')?.value).toBe('piped-value');

    const echoRes = await shell.executeCommand('echo $K2');
    expect(echoRes.exitCode).toBe(0);
    expect(echoRes.stdout.trim()).toBe(maskFor('piped-value'));
  });

  it('errors when both arg and stdin are provided', async () => {
    const shell = new AlmostBashShell({ fs });
    const res = await shell.executeCommand('echo stdin-v | secret set K arg-v --domain api.x.com');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('argument OR via stdin');
    expect(session.has('K')).toBe(false);
  });
});
