/**
 * `curlwright` end-to-end: argv → injected page script → a real
 * `Response` → stdout / VFS bytes.
 *
 * The fake browser evaluates the SAME script the command builds, via
 * `new Function('fetch', …)`, so these tests exercise the actual
 * request shaping and response assembly rather than a mock of them.
 * That is what makes the byte-exactness assertions meaningful.
 */

import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/index.js';
import { createCurlwrightCommand } from '../../../src/shell/supplemental-commands/curlwright-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

type PageStub = { targetId: string; title: string; url: string };

const DEFAULT_PAGES: PageStub[] = [
  { targetId: 'tab-app', title: 'App', url: 'https://app.example.com/dashboard' },
];

interface Harness {
  browser: BrowserAPI;
  captured: { url?: string; init?: RequestInit; targetId?: string; frameId?: string };
}

function harness(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  pages: PageStub[] = DEFAULT_PAGES
): Harness {
  const captured: Harness['captured'] = {};
  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    captured.url = url;
    captured.init = init;
    return handler(url, init);
  };
  const run = (source: string): Promise<unknown> =>
    new Function('fetch', `return ${source};`)(fakeFetch) as Promise<unknown>;
  const browser = {
    listAllTargets: vi.fn(async () => pages),
    listPages: vi.fn(async () => pages),
    withTab: async <T>(targetId: string, fn: () => Promise<T>): Promise<T> => {
      captured.targetId = targetId;
      return fn();
    },
    evaluate: (source: string) => run(source),
    evaluateInFrame: (frameId: string, source: string) => {
      captured.frameId = frameId;
      return run(source);
    },
  } as unknown as BrowserAPI;
  return { browser, captured };
}

/** In-memory VFS stub good enough for `-o`, `-D`, `-d @file` and `-F`. */
function fsStub(files: Record<string, Uint8Array> = {}): {
  fs: Partial<IFileSystem>;
  written: Record<string, Uint8Array>;
} {
  const written: Record<string, Uint8Array> = {};
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    readFileBuffer: (async (path: string) => {
      const bytes = files[path];
      if (!bytes) throw new Error('ENOENT');
      return bytes;
    }) as unknown as IFileSystem['readFileBuffer'],
    writeFile: (async (path: string, data: unknown) => {
      written[path] = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    }) as unknown as IFileSystem['writeFile'],
  };
  return { fs, written };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('curlwright — request shaping', () => {
  it('sends -X, -H and -d through to the page fetch verbatim', async () => {
    const { browser, captured } = harness(() => jsonResponse({ ok: true }, 201));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      [
        '-s',
        '-X',
        'POST',
        'https://app.example.com/api/v1/items',
        '-H',
        'X-CSRF-Token: abc',
        '-d',
        '{"name":"x"}',
      ],
      mockCommandContext({ fs, cwd: '/workspace' })
    );

    expect(result.exitCode).toBe(0);
    expect(captured.url).toBe('https://app.example.com/api/v1/items');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('abc');
    // A body with no -H Content-Type gets curl's form-urlencoded default.
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new TextDecoder().decode(captured.init?.body as Uint8Array)).toBe('{"name":"x"}');
    expect(result.stdout).toBe('{"ok":true}');
  });

  it('defaults credentials to include, and --no-credentials opts out', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const cmd = createCurlwrightCommand(browser);
    await cmd.execute(['-s', 'https://app.example.com/a'], mockCommandContext({ fs }));
    expect(captured.init?.credentials).toBe('include');
    await cmd.execute(
      ['-s', '--no-credentials', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(captured.init?.credentials).toBe('omit');
  });

  it('lets an explicit -H Content-Type win over the -d default', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/a', '-H', 'Content-Type: text/plain', '-d', 'hi'],
      mockCommandContext({ fs })
    );
    expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('POSTs by default when a body is present, GETs otherwise', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const cmd = createCurlwrightCommand(browser);
    await cmd.execute(['-s', 'https://app.example.com/a'], mockCommandContext({ fs }));
    expect(captured.init?.method).toBe('GET');
    await cmd.execute(['-s', 'https://app.example.com/a', '-d', 'x=1'], mockCommandContext({ fs }));
    expect(captured.init?.method).toBe('POST');
  });

  it('--json sets both Content-Type and Accept', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/a', '--json', '{"a":1}'],
      mockCommandContext({ fs })
    );
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });

  it('-G moves the data onto the query string and keeps the method GET', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '-G', 'https://app.example.com/search?page=2', '-d', 'q=cone', '-d', 'limit=5'],
      mockCommandContext({ fs })
    );
    expect(captured.url).toBe('https://app.example.com/search?page=2&q=cone&limit=5');
    expect(captured.init?.method).toBe('GET');
    expect(captured.init?.body).toBeUndefined();
  });

  it('-u builds a Basic Authorization header', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '-u', 'ada:hunter2', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${btoa('ada:hunter2')}`);
  });

  it('reads -d @file, stripping newlines, and --data-binary @file, keeping them', async () => {
    const file = new TextEncoder().encode('a=1\nb=2\n');
    const { fs } = fsStub({ '/workspace/payload.txt': file });
    const cmd = createCurlwrightCommand(harness(() => jsonResponse({})).browser);
    const stripped = harness(() => jsonResponse({}));
    await createCurlwrightCommand(stripped.browser).execute(
      ['-s', 'https://app.example.com/a', '-d', '@payload.txt'],
      mockCommandContext({ fs, cwd: '/workspace' })
    );
    expect(new TextDecoder().decode(stripped.captured.init?.body as Uint8Array)).toBe('a=1b=2');

    const kept = harness(() => jsonResponse({}));
    await createCurlwrightCommand(kept.browser).execute(
      ['-s', 'https://app.example.com/a', '--data-binary', '@payload.txt'],
      mockCommandContext({ fs, cwd: '/workspace' })
    );
    expect(new TextDecoder().decode(kept.captured.init?.body as Uint8Array)).toBe('a=1\nb=2\n');
    expect(cmd.name).toBe('curlwright');
  });

  it('--data-raw never treats a leading @ as a file', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/a', '--data-raw', '@literal'],
      mockCommandContext({ fs })
    );
    expect(new TextDecoder().decode(captured.init?.body as Uint8Array)).toBe('@literal');
  });

  it('--data-urlencode encodes content and name=content alike', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/a', '--data-urlencode', 'q=two words&more'],
      mockCommandContext({ fs })
    );
    expect(new TextDecoder().decode(captured.init?.body as Uint8Array)).toBe(
      'q=two%20words%26more'
    );
  });

  it('-F builds a real multipart FormData with the file bytes', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const { fs } = fsStub({ '/workspace/logo.png': bytes });
    const { browser, captured } = harness(() => jsonResponse({}));
    await createCurlwrightCommand(browser).execute(
      [
        '-s',
        'https://app.example.com/upload',
        '-F',
        'note=hi',
        '-F',
        'file=@logo.png;type=image/png',
      ],
      mockCommandContext({ fs, cwd: '/workspace' })
    );
    const form = captured.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('note')).toBe('hi');
    const file = form.get('file') as File;
    expect(file.name).toBe('logo.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('runs in a child frame when --frame is given', async () => {
    const { browser, captured } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '--tab', 'tab-app', '--frame', 'frame-7', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(captured.frameId).toBe('frame-7');
  });
});

describe('curlwright — output', () => {
  it('writes a byte-exact binary body to the VFS with -o', async () => {
    // Bytes that are neither valid UTF-8 nor NUL-free — the exact shape
    // that a text round trip would silently mangle.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const { browser } = harness(
      () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    );
    const { fs, written } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', '-o', '/tmp/out.png', 'https://app.example.com/asset.png'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(written['/tmp/out.png']).toEqual(png);
  });

  it('-O derives the file name from the URL path', async () => {
    const { browser } = harness(() => new Response('body', { status: 200 }));
    const { fs, written } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '-O', 'https://app.example.com/files/report.csv?v=2'],
      mockCommandContext({ fs, cwd: '/workspace' })
    );
    expect(new TextDecoder().decode(written['/workspace/report.csv'])).toBe('body');
  });

  it('refuses to dump a binary body onto stdout, and -o - forces it', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02]);
    const { fs } = fsStub();
    const guarded = await createCurlwrightCommand(
      harness(() => new Response(bytes, { status: 200 })).browser
    ).execute(['https://app.example.com/blob'], mockCommandContext({ fs }));
    expect(guarded.stdout).toBe('');
    expect(guarded.stderr).toContain('Binary output can mess up your terminal');
    expect(guarded.exitCode).toBe(0);

    const forced = await createCurlwrightCommand(
      harness(() => new Response(bytes, { status: 200 })).browser
    ).execute(['-o', '-', 'https://app.example.com/blob'], mockCommandContext({ fs }));
    expect(forced.stdout.length).toBeGreaterThan(0);
  });

  it('does not reformat a JSON body on its way to stdout', async () => {
    const raw = '{"b":2,  "a":1}';
    const { browser } = harness(
      () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/api/me'],
      mockCommandContext({ fs })
    );
    expect(result.stdout).toBe(raw);
  });

  it('-i prefixes the header block, -I sends HEAD and prints headers only', async () => {
    const { browser, captured } = harness(
      () =>
        new Response('hello', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/plain' },
        })
    );
    const { fs } = fsStub();
    const cmd = createCurlwrightCommand(browser);
    const included = await cmd.execute(
      ['-s', '-i', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(included.stdout).toContain('HTTP/1.1 200 OK\r\n');
    expect(included.stdout).toContain('content-type: text/plain\r\n');
    expect(included.stdout.endsWith('hello')).toBe(true);

    const head = await cmd.execute(
      ['-s', '-I', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(captured.init?.method).toBe('HEAD');
    expect(head.stdout).toContain('HTTP/1.1 200 OK');
    expect(head.stdout).not.toContain('hello');
  });

  it('-D writes the header block to a file', async () => {
    const { browser } = harness(
      () => new Response('x', { status: 200, statusText: 'OK', headers: { 'x-a': '1' } })
    );
    const { fs, written } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '-D', '/tmp/h.txt', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    const dumped = new TextDecoder().decode(written['/tmp/h.txt']);
    expect(dumped).toContain('HTTP/1.1 200 OK\r\n');
    expect(dumped).toContain('x-a: 1\r\n');
  });

  it('-v traces the request and response to stderr, even under -s', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', '-v', 'https://app.example.com/a', '-H', 'X-Trace: 1'],
      mockCommandContext({ fs })
    );
    expect(result.stderr).toContain('> GET https://app.example.com/a');
    expect(result.stderr).toContain('> X-Trace: 1');
    expect(result.stderr).toContain('< HTTP/1.1 200');
  });
});

describe('curlwright — --write-out', () => {
  it('prints %{http_code} for a cookie-bound endpoint the sandbox cannot reach', async () => {
    const { browser } = harness(
      () => new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } })
    );
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', '-o', '/tmp/a.png', '-w', '%{http_code}', 'https://p27-iwres.icloud.com/asset'],
      mockCommandContext({ fs })
    );
    expect(result.stdout).toBe('200');
    expect(result.exitCode).toBe(0);
  });

  it('expands sizes, content type, method and escapes', async () => {
    const { browser } = harness(
      () => new Response('12345', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      [
        '-s',
        '-o',
        '/tmp/x',
        '-w',
        '%{method} %{size_download} %{content_type} %header{content-type} 100%%\\n',
        'https://app.example.com/a',
      ],
      mockCommandContext({ fs })
    );
    expect(result.stdout).toBe('GET 5 text/plain text/plain 100%\n');
  });

  it('reports an unknown --write-out variable instead of echoing it', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-o', '/tmp/x', '-w', '[%{nope}]', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.stdout).toBe('[]');
    expect(result.stderr).toContain("unknown --write-out variable: 'nope'");
  });
});

describe('curlwright — failure modes', () => {
  it('names an unsupported curl flag and exits non-zero', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const cmd = createCurlwrightCommand(browser);
    for (const flag of [
      ['--cert', 'client.pem'],
      ['-k'],
      ['--compressed'],
      ['--resolve', 'a:1:2'],
      ['-x', 'http://proxy'],
    ]) {
      const result = await cmd.execute(
        [...flag, 'https://app.example.com/a'],
        mockCommandContext({ fs })
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(flag[0]);
    }
  });

  it('names an unknown flag', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['--wat', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown option --wat');
  });

  it('rejects a header the browser would silently strip', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-H', 'Origin: https://evil.example', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Origin');
  });

  it('exits 22 with --fail on an HTTP error, and suppresses the body', async () => {
    const { browser } = harness(() => jsonResponse({ error: 'nope' }, 403));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['--fail', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(22);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('returned error: 403');
  });

  it('without --fail an HTTP error is still a body and exit 0', async () => {
    const { browser } = harness(() => jsonResponse({ error: 'nope' }, 403));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"error":"nope"}');
  });

  it('exits 28 when --max-time expires', async () => {
    const { browser } = harness(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('signal timed out', 'TimeoutError'))
          );
        })
    );
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['--max-time', '0.05', 'https://app.example.com/slow'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(28);
    expect(result.stderr).toContain('Operation timed out');
  });

  it('exits 7 when the page fetch itself fails', async () => {
    const { browser } = harness(() => {
      throw new TypeError('Failed to fetch');
    });
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('Failed to fetch');
  });

  it('-s hides errors and -S brings them back', async () => {
    const failing = (): Response => {
      throw new TypeError('Failed to fetch');
    };
    const { fs } = fsStub();
    const quiet = await createCurlwrightCommand(harness(failing).browser).execute(
      ['-s', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(quiet.stderr).toBe('');
    const loud = await createCurlwrightCommand(harness(failing).browser).execute(
      ['-sS', 'https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(loud.stderr).toContain('Failed to fetch');
  });

  it('exits 26 when a -d @file cannot be read', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['https://app.example.com/a', '-d', '@missing.json'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(26);
    expect(result.stderr).toContain('cannot read missing.json');
  });

  it('reports a missing URL and a second URL', async () => {
    const { browser } = harness(() => jsonResponse({}));
    const { fs } = fsStub();
    const cmd = createCurlwrightCommand(browser);
    expect((await cmd.execute([], mockCommandContext({ fs }))).exitCode).toBe(2);
    expect((await cmd.execute(['-s'], mockCommandContext({ fs }))).stderr).toContain('no URL');
    const two = await cmd.execute(
      ['https://a.example/1', 'https://b.example/2'],
      mockCommandContext({ fs })
    );
    expect(two.exitCode).toBe(2);
    expect(two.stderr).toContain('only one URL');
  });

  it('explains itself when no browser backend is wired', async () => {
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(null).execute(
      ['https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');
  });

  it('prints help for --help without touching the browser', async () => {
    const { browser } = harness(() => {
      throw new Error('should not fetch');
    });
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['--help'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("curl's arguments, executed inside a browser tab");
  });
});

describe('curlwright — tab selection', () => {
  const pages: PageStub[] = [
    { targetId: 'tab-app', title: 'App', url: 'https://app.example.com/dashboard' },
    { targetId: 'tab-docs', title: 'Docs', url: 'https://docs.example.org/' },
  ];

  it('picks the tab already on the URL origin', async () => {
    const { browser, captured } = harness(() => jsonResponse({}), pages);
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', 'https://docs.example.org/api/x'],
      mockCommandContext({ fs })
    );
    expect(captured.targetId).toBe('tab-docs');
  });

  it('honors an explicit --tab over the origin match', async () => {
    const { browser, captured } = harness(() => jsonResponse({}), pages);
    const { fs } = fsStub();
    await createCurlwrightCommand(browser).execute(
      ['-s', '--tab', 'tab-app', 'https://docs.example.org/api/x'],
      mockCommandContext({ fs })
    );
    expect(captured.targetId).toBe('tab-app');
  });

  it('lists the candidates when nothing matches and several tabs are open', async () => {
    const { browser } = harness(() => jsonResponse({}), pages);
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['https://other.example.net/api'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--tab=tab-app');
    expect(result.stderr).toContain('--tab=tab-docs');
  });

  it('falls back to the only open tab, which also makes a relative URL work', async () => {
    const { browser, captured } = harness(() => jsonResponse({ me: 1 }));
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['-s', '/api/me'],
      mockCommandContext({ fs })
    );
    expect(captured.targetId).toBe('tab-app');
    expect(captured.url).toBe('/api/me');
    expect(result.exitCode).toBe(0);
  });

  it('says so when there are no tabs at all', async () => {
    const { browser } = harness(() => jsonResponse({}), []);
    const { fs } = fsStub();
    const result = await createCurlwrightCommand(browser).execute(
      ['https://app.example.com/a'],
      mockCommandContext({ fs })
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no open tabs');
  });
});
