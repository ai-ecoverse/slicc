import { describe, expect, it, vi } from 'vitest';
import { LinkPreviewFetcher, type PreviewFetch } from '../../src/ui/link-preview-fetcher.js';

function htmlResponse(html: string, headers: Record<string, string> = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: new TextEncoder().encode(html),
    url: '',
  };
}

function fetcherWith(impl: PreviewFetch) {
  const fetchFn = vi.fn(impl);
  return { fetchFn, fetcher: new LinkPreviewFetcher({ getFetch: () => fetchFn }) };
}

describe('LinkPreviewFetcher', () => {
  it('reads the page card through the injected fetch', async () => {
    const { fetcher, fetchFn } = fetcherWith(async () =>
      htmlResponse(
        '<head><meta property="og:title" content="Hi"><meta property="og:image" content="/c.png"></head>'
      )
    );
    const preview = await fetcher.preview('https://example.com/a');
    expect(preview).toEqual({
      url: 'https://example.com/a',
      state: 'ready',
      title: 'Hi',
      image: 'https://example.com/c.png',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('caches, including in-flight requests', async () => {
    const { fetcher, fetchFn } = fetcherWith(async () => htmlResponse('<title>T</title>'));
    const [a, b] = await Promise.all([
      fetcher.preview('https://x.test/'),
      fetcher.preview('https://x.test/'),
    ]);
    expect(a).toBe(b);
    expect(fetcher.peek('https://x.test/')).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('needs no request for image links or any carded GitHub page', async () => {
    const { fetcher, fetchFn } = fetcherWith(async () => htmlResponse(''));
    expect(await fetcher.preview('https://cdn.test/pic.PNG')).toMatchObject({
      state: 'ready',
      image: 'https://cdn.test/pic.PNG',
      title: 'pic.PNG',
    });
    expect(await fetcher.preview('https://github.com/o/r/pull/5')).toMatchObject({
      state: 'ready',
      title: 'o/r#5',
      badge: 'PR #5',
      siteName: 'GitHub',
      image: 'https://opengraph.githubassets.com/slicc/o/r/pull/5',
    });
    expect(await fetcher.preview('https://github.com/o/r')).toMatchObject({
      state: 'ready',
      title: 'o/r',
      badge: 'Repository',
      siteName: 'GitHub',
      image: 'https://opengraph.githubassets.com/slicc/o/r',
    });
    expect(await fetcher.preview('https://github.com/orgs/acme/projects/4')).toMatchObject({
      state: 'ready',
      title: 'acme#4',
      badge: 'Project #4',
      siteName: 'GitHub',
      image: 'https://opengraph.githubassets.com/slicc/orgs/acme/projects/4',
    });
    // Blob pages keep the repository card even when the path ends in an image ext.
    expect(await fetcher.preview('https://github.com/o/r/blob/main/logo.png')).toMatchObject({
      state: 'ready',
      badge: 'Repository',
      image: 'https://opengraph.githubassets.com/slicc/o/r',
    });
    // Resource-serving image routes preview the file itself, not the repo card.
    expect(await fetcher.preview('https://github.com/o/r/raw/main/logo.png')).toMatchObject({
      state: 'ready',
      image: 'https://github.com/o/r/raw/main/logo.png',
      title: 'logo.png',
    });
    expect(
      await fetcher.preview('https://github.com/o/r/releases/download/v1/shot.webp')
    ).toMatchObject({
      state: 'ready',
      image: 'https://github.com/o/r/releases/download/v1/shot.webp',
      title: 'shot.webp',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('still fetches a github.com page with no card of its own', async () => {
    const { fetcher, fetchFn } = fetcherWith(async () =>
      htmlResponse('<meta property="og:title" content="Settings">')
    );
    expect(await fetcher.preview('https://github.com/settings/tokens')).toMatchObject({
      state: 'ready',
      title: 'Settings',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('previews an image served without an image extension', async () => {
    const { fetcher } = fetcherWith(async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(4),
    }));
    expect(await fetcher.preview('https://img.test/render')).toMatchObject({
      state: 'ready',
      image: 'https://img.test/render',
    });
  });

  it('reports errors instead of rejecting', async () => {
    const cases: PreviewFetch[] = [
      async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
      async () => ({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: new Uint8Array(),
      }),
      async () => htmlResponse('<html><body>nothing</body></html>'),
      async () => {
        throw new Error('network');
      },
    ];
    for (const impl of cases) {
      const { fetcher } = fetcherWith(impl);
      expect(await fetcher.preview('https://e.test/')).toEqual({
        url: 'https://e.test/',
        state: 'error',
      });
    }
    const { fetcher } = fetcherWith(async () => htmlResponse(''));
    expect((await fetcher.preview('ftp://e.test/')).state).toBe('error');
  });

  it('times out a hung request', async () => {
    const fetcher = new LinkPreviewFetcher({
      getFetch: () => () => new Promise(() => {}),
      timeoutMs: 10,
    });
    expect((await fetcher.preview('https://slow.test/')).state).toBe('error');
  });

  it('aborts the underlying request when it times out', async () => {
    let seen: AbortSignal | undefined;
    const fetcher = new LinkPreviewFetcher({
      getFetch: () => (_url, options) => {
        seen = options?.signal;
        return new Promise(() => {});
      },
      timeoutMs: 10,
    });
    await fetcher.preview('https://slow.test/');
    expect(seen?.aborted).toBe(true);
  });

  it('evicts the oldest entry past its size cap', async () => {
    const fetcher = new LinkPreviewFetcher({
      getFetch: () => async () => htmlResponse('<title>t</title>'),
      maxEntries: 2,
    });
    await fetcher.preview('https://1.test/');
    await fetcher.preview('https://2.test/');
    await fetcher.preview('https://3.test/');
    expect(fetcher.peek('https://1.test/')).toBeUndefined();
    expect(fetcher.peek('https://3.test/')).toBeDefined();
  });
});
