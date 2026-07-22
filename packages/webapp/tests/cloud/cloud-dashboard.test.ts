import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloud dashboard cone counts', () => {
  it('shows counts without disabling create at the former cap', async () => {
    const html = await readFile(new URL('../../cloud/index.html', import.meta.url), 'utf8');
    dom = new JSDOM(html, { url: 'https://www.sliccy.ai/cloud' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);

    dom.window.localStorage.setItem('cloud-ims-token', 'token');
    dom.window.localStorage.setItem('cloud-ims-token-exp', String(Date.now() + 60_000));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/cloud/config')) {
          return Response.json({
            imsRelayUrl: 'https://www.sliccy.ai/auth/callback',
            imsReceivePath: '/auth/cloud-callback',
            adobeModels: [],
          });
        }
        if (url.endsWith('/api/cloud/list')) {
          return Response.json({
            cones: [
              {
                sandboxId: 'running-1',
                state: 'running',
                lastSeen: new Date().toISOString(),
                joinUrl: 'https://www.sliccy.ai/join/running-1',
              },
              ...Array.from({ length: 5 }, (_, index) => ({
                sandboxId: `paused-${index + 1}`,
                state: 'paused',
                lastSeen: new Date().toISOString(),
                joinUrl: '',
              })),
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    // @ts-expect-error plain-JS cloud dashboard module ships no types
    await import('../../cloud/app.js');

    await vi.waitFor(() => {
      expect(document.getElementById('cone-counts')?.textContent).toBe('1 running · 5 paused');
    });
    const createButton = document.getElementById('create-btn') as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    expect(createButton.title).toBe('');
  });
});
