import { describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../../../../src/fs/index.js';
import {
  stateLoadHandler,
  stateSaveHandler,
} from '../../../../../src/shell/supplemental-commands/playwright/handlers/state.js';
import { createHandlerCtx, createMockBrowser } from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

/** Runtime.evaluate reply helper. */
const evalReply = (value: unknown) => ({ result: { value } });

describe('state-save handler', () => {
  it('requires a --tab flag', async () => {
    const result = await stateSaveHandler(createHandlerCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tab');
  });

  it('serializes cookies + localStorage to the default path', async () => {
    const { browser, transport } = createMockBrowser({
      sendCdpImpl: (method) =>
        method === 'Network.getCookies' ? { cookies: [{ name: 'sid', value: '1' }] } : {},
    });
    transport.send.mockImplementation(async (_m: string, params?: Record<string, unknown>) => {
      const expr = String(params?.['expression'] ?? '');
      if (expr === 'location.origin') return evalReply('https://site.test');
      if (expr.includes('Object.entries(localStorage)')) {
        return evalReply(JSON.stringify([{ name: 'token', value: 'abc' }]));
      }
      return {};
    });

    const writeFile = vi.fn(async () => undefined);
    const result = await stateSaveHandler(
      createHandlerCtx({
        browser,
        flags: { tab: TAB },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/.playwright/storage-state.json');
    const [path, json] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(path).toBe('/.playwright/storage-state.json');
    const parsed = JSON.parse(json);
    expect(parsed.cookies).toEqual([{ name: 'sid', value: '1' }]);
    expect(parsed.origins[0]).toEqual({
      origin: 'https://site.test',
      localStorage: [{ name: 'token', value: 'abc' }],
    });
  });

  it('omits origins when the tab has no origin and honors --filename', async () => {
    const { browser, transport } = createMockBrowser();
    transport.send.mockImplementation(async (_m: string, params?: Record<string, unknown>) => {
      const expr = String(params?.['expression'] ?? '');
      if (expr === 'location.origin') return evalReply('');
      return evalReply('[]');
    });
    const writeFile = vi.fn(async () => undefined);
    const result = await stateSaveHandler(
      createHandlerCtx({
        browser,
        flags: { tab: TAB, filename: '/custom.json' },
        fs: { writeFile: writeFile as unknown as VirtualFS['writeFile'] },
      })
    );
    expect(result.stdout).toContain('/custom.json');
    const parsed = JSON.parse((writeFile.mock.calls[0] as unknown as [string, string])[1]);
    expect(parsed.origins).toEqual([]);
  });
});

describe('state-load handler', () => {
  it('requires a filename', async () => {
    const result = await stateLoadHandler(createHandlerCtx({ flags: { tab: TAB } }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('requires a filename');
  });

  it('requires a --tab flag', async () => {
    const result = await stateLoadHandler(createHandlerCtx({ positional: ['/s.json'] }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tab');
  });

  it('reports a read failure', async () => {
    const result = await stateLoadHandler(
      createHandlerCtx({
        positional: ['/missing.json'],
        flags: { tab: TAB },
        fs: {
          readTextFile: (async () => {
            throw new Error('ENOENT');
          }) as unknown as VirtualFS['readTextFile'],
        },
      })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Failed to read storage state');
  });

  it('restores cookies and matching-origin localStorage, skipping others', async () => {
    const setCookies = vi.fn();
    const { browser, transport } = createMockBrowser({
      sendCdpImpl: (method, params) => {
        if (method === 'Network.setCookies') setCookies(params);
        return {};
      },
    });
    transport.send.mockImplementation(async (_m: string, params?: Record<string, unknown>) => {
      const expr = String(params?.['expression'] ?? '');
      if (expr === 'location.origin') return evalReply('https://a.test');
      return {};
    });

    const storageState = {
      cookies: [{ name: 'sid', value: '1' }],
      origins: [
        { origin: 'https://a.test', localStorage: [{ name: 'k', value: 'v' }] },
        { origin: 'https://b.test', localStorage: [{ name: 'x', value: 'y' }] },
      ],
    };
    const result = await stateLoadHandler(
      createHandlerCtx({
        browser,
        positional: ['/s.json'],
        flags: { tab: TAB },
        fs: {
          readTextFile: (async () =>
            JSON.stringify(storageState)) as unknown as VirtualFS['readTextFile'],
        },
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Loaded storage state from /s.json');
    expect(setCookies).toHaveBeenCalledWith({ cookies: storageState.cookies });
    expect(result.stderr).toContain(
      'Skipped localStorage for non-matching origins: https://b.test'
    );
    // The matching origin's setItem script was evaluated.
    const evaluatedItemScript = transport.send.mock.calls.some(
      (c) =>
        typeof c[1] === 'object' &&
        String((c[1] as { expression?: string }).expression).includes('localStorage.setItem')
    );
    expect(evaluatedItemScript).toBe(true);
  });
});
