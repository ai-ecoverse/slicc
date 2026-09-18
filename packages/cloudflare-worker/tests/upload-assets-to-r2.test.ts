import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAllHashed,
  buildBulkPutArgs,
  buildManifestGroups,
  chunkEntries,
  MANIFEST_CHUNK_SIZE,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  retryConcurrency,
  retryDelayMs,
  runBulkUploads,
  totalFileBytes,
} from '../scripts/upload-lib.mjs';

function optionValue(argv: string[], option: string): string {
  const index = argv.indexOf(option);
  if (index === -1 || argv[index + 1] === undefined) {
    throw new Error(`Missing ${option} in ${argv.join(' ')}`);
  }
  return argv[index + 1];
}

async function readManifest(argv: string[]) {
  return JSON.parse(await readFile(optionValue(argv, '--filename'), 'utf8')) as Array<{
    key: string;
    file: string;
  }>;
}

describe('assertAllHashed', () => {
  it('passes when all names are hashed', () => {
    const names = [
      'anthropic-messages-DP3-Xd3J.js',
      'index-a1b2c3d4.css',
      'entry-abcd1234.js.map',
      'logo-DEADBEEF.svg',
      'AdobeClean-Regular-CVsq5gF7.otf',
    ];
    expect(() => assertAllHashed(names)).not.toThrow();
  });

  it('throws when any name lacks a hash', () => {
    expect(() => assertAllHashed(['anthropic-messages-DP3-Xd3J.js', 'index.html'])).toThrow(
      'Asset not hashed: index.html'
    );
  });
});

describe('buildManifestGroups', () => {
  it('preserves object keys, file paths, and per-type metadata groups', () => {
    const groups = buildManifestGroups(
      [
        'app-abc1234d.js',
        'index-a1b2c3d4.css',
        'worker-def5678g.js',
        'AdobeClean-Regular-CVsq5gF7.otf',
      ],
      '/assets'
    );

    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({
      contentType: 'text/javascript',
      entries: [
        { key: 'assets/app-abc1234d.js', file: '/assets/app-abc1234d.js' },
        { key: 'assets/worker-def5678g.js', file: '/assets/worker-def5678g.js' },
      ],
    });
    expect(groups).toEqual(
      expect.arrayContaining([
        {
          contentType: 'text/css',
          entries: [{ key: 'assets/index-a1b2c3d4.css', file: '/assets/index-a1b2c3d4.css' }],
        },
        {
          contentType: 'font/otf',
          entries: [
            {
              key: 'assets/AdobeClean-Regular-CVsq5gF7.otf',
              file: '/assets/AdobeClean-Regular-CVsq5gF7.otf',
            },
          ],
        },
      ])
    );
  });
});

describe('buildBulkPutArgs', () => {
  it('builds a remote, non-interactive bulk command with bounded concurrency', () => {
    expect(buildBulkPutArgs('archive', '/tmp/manifest.json', 'text/css', 20)).toEqual([
      'wrangler',
      'r2',
      'bulk',
      'put',
      'archive',
      '--filename',
      '/tmp/manifest.json',
      '--content-type',
      'text/css',
      '--concurrency',
      '20',
      '--remote',
      '--force',
    ]);
  });
});

describe('totalFileBytes', () => {
  it('keeps the log-only byte count best-effort when a file vanishes', async () => {
    const stat = vi.fn(async (path: string) => {
      if (path.endsWith('gone-def5678g.js')) {
        throw new Error('ENOENT');
      }
      return { size: 1024 };
    });

    await expect(
      totalFileBytes(['app-abc1234d.js', 'gone-def5678g.js'], '/assets', stat)
    ).resolves.toBe(1024);
    expect(stat).toHaveBeenCalledTimes(2);
  });
});

describe('runBulkUploads', () => {
  it('uses one Wrangler process per content type and re-puts every object', async () => {
    const calls: Array<{ argv: string[]; manifest: Awaited<ReturnType<typeof readManifest>> }> = [];
    const execMock = vi.fn(async (argv: string[]) => {
      calls.push({ argv, manifest: await readManifest(argv) });
    });
    const files = [
      'app-abc1234d.js',
      'worker-def5678g.js',
      'index-a1b2c3d4.css',
      'module-xyz78901.wasm',
    ];

    const result = await runBulkUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      concurrency: 7,
    });

    expect(result).toEqual({ groups: 3, chunks: 3, invocations: 3, retries: 0 });
    expect(execMock).toHaveBeenCalledTimes(3);
    for (const { argv } of calls) {
      expect(argv.slice(0, 5)).toEqual(['wrangler', 'r2', 'bulk', 'put', 'test-bucket']);
      expect(optionValue(argv, '--concurrency')).toBe('7');
      expect(argv).toContain('--remote');
      expect(argv).toContain('--force');
    }

    const uploadedKeys = calls.flatMap(({ manifest }) => manifest.map(({ key }) => key));
    expect(uploadedKeys).toEqual(expect.arrayContaining(files.map((file) => `assets/${file}`)));
  });

  it('removes temporary manifests after a successful upload', async () => {
    const paths: string[] = [];
    await runBulkUploads(['file-abc12345.js'], {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: vi.fn(async (argv: string[]) => {
        const path = optionValue(argv, '--filename');
        paths.push(path);
        expect(await readManifest(argv)).toHaveLength(1);
      }),
    });

    await expect(readFile(paths[0], 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs content-type groups sequentially instead of multiplying concurrency', async () => {
    let releaseFirst = () => {};
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execMock = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockImplementationOnce(async () => firstDone)
      .mockResolvedValueOnce(undefined);

    const run = runBulkUploads(['app-abc1234d.js', 'index-a1b2c3d4.css'], {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      concurrency: 20,
    });

    await vi.waitFor(() => expect(execMock).toHaveBeenCalledTimes(1));
    releaseFirst();
    await run;
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed content-type manifest', async () => {
    const execMock = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runBulkUploads(['file-abc12345.js'], {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      retries: 3,
      sleep,
    });

    expect(result).toEqual({ groups: 1, chunks: 1, invocations: 3, retries: 2 });
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries and still removes its manifest', async () => {
    const paths: string[] = [];
    const execMock = vi.fn(async (argv: string[]) => {
      paths.push(optionValue(argv, '--filename'));
      throw new Error('Always fails');
    });

    await expect(
      runBulkUploads(['file-abc12345.js'], {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
        retries: 2,
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('Always fails');

    expect(execMock).toHaveBeenCalledTimes(2);
    await expect(readFile(paths[0], 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not upload anything when the hash invariant fails', async () => {
    const execMock = vi.fn();
    await expect(
      runBulkUploads(['unhashed.js', 'valid-abc12345.js'], {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
      })
    ).rejects.toThrow('Asset not hashed: unhashed.js');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('returns an empty summary without invoking Wrangler for an empty directory', async () => {
    const execMock = vi.fn();
    await expect(
      runBulkUploads([], { bucket: 'test-bucket', dir: '/assets', exec: execMock })
    ).resolves.toEqual({ groups: 0, chunks: 0, invocations: 0, retries: 0 });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('uses a real timer backoff when no sleep is injected', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('429: Too Many Requests'));
    const start = Date.now();

    await expect(
      runBulkUploads(['file-abc12345.js'], {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
        retries: 2,
      })
    ).rejects.toThrow('429: Too Many Requests');

    expect(execMock).toHaveBeenCalledTimes(2);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS / 2 - 50);
    expect(elapsed).toBeLessThan(RETRY_BASE_DELAY_MS * 2);
  });

  it('does not sleep when the first attempt succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runBulkUploads(['file-abc12345.js'], {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: vi.fn().mockResolvedValue(undefined),
      retries: 5,
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    const top = () => 1;
    expect(retryDelayMs(1, top)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(2, top)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(3, top)).toBe(RETRY_BASE_DELAY_MS * 4);
  });

  it('always waits at least half the step, so a 429 is never retried at once', () => {
    expect(retryDelayMs(1, () => 0)).toBe(RETRY_BASE_DELAY_MS / 2);
    expect(retryDelayMs(3, () => 0)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(3, () => 0.5)).toBe(RETRY_BASE_DELAY_MS * 3);
  });

  it('caps a single wait so the schedule stays inside the job budget', () => {
    expect(retryDelayMs(20, () => 1)).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(20, () => 0)).toBe(RETRY_MAX_DELAY_MS / 2);
  });

  it('spans a real part of the five-minute API window across eight attempts', () => {
    let floor = 0;
    for (let attempt = 1; attempt < 8; attempt++) floor += retryDelayMs(attempt, () => 0);
    expect(floor).toBeGreaterThanOrEqual(90_000);
  });
});

describe('retryConcurrency', () => {
  it('halves on every retry and never drops below one', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryConcurrency(20, attempt))).toEqual([
      20, 10, 5, 2, 1, 1,
    ]);
    expect(retryConcurrency(0, 1)).toBe(1);
  });
});

describe('chunkEntries', () => {
  it('splits in order into bounded chunks', () => {
    expect(chunkEntries([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkEntries([], 2)).toEqual([]);
    expect(chunkEntries([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('runBulkUploads chunked retry', () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => `chunk-${String(i).padStart(8, '0')}.js`);

  it('splits a large content type into bounded manifests', async () => {
    const sizes: number[] = [];
    const result = await runBulkUploads(files(MANIFEST_CHUNK_SIZE * 2 + 5), {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: vi.fn(async (argv: string[]) => {
        sizes.push((await readManifest(argv)).length);
      }),
    });

    expect(sizes).toEqual([MANIFEST_CHUNK_SIZE, MANIFEST_CHUNK_SIZE, 5]);
    expect(result).toEqual({ groups: 1, chunks: 3, invocations: 3, retries: 0 });
  });

  it('retries only the chunk that failed, with backoff and halved concurrency', async () => {
    const sent: Array<{ keys: string[]; concurrency: string }> = [];
    let failures = 2;
    const exec = vi.fn(async (argv: string[]) => {
      const manifest = await readManifest(argv);
      sent.push({
        keys: manifest.map((entry) => entry.key),
        concurrency: optionValue(argv, '--concurrency'),
      });

      if (manifest[0].key.endsWith('00000003.js') && failures-- > 0) {
        throw new Error('429: Too Many Requests');
      }
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const result = await runBulkUploads(files(7), {
      bucket: 'test-bucket',
      dir: '/assets',
      exec,
      concurrency: 8,
      retries: 5,
      chunkSize: 3,
      sleep,
      random: () => 0,
      log,
    });

    expect(result).toEqual({ groups: 1, chunks: 3, invocations: 5, retries: 2 });
    expect(sent.map((call) => call.keys[0])).toEqual([
      'assets/chunk-00000000.js',
      'assets/chunk-00000003.js',
      'assets/chunk-00000003.js',
      'assets/chunk-00000003.js',
      'assets/chunk-00000006.js',
    ]);

    expect(sent.slice(1, 4).every((call) => call.keys.length === 3)).toBe(true);
    expect(sent.map((call) => call.concurrency)).toEqual(['8', '8', '4', '2', '8']);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      RETRY_BASE_DELAY_MS / 2,
      RETRY_BASE_DELAY_MS,
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chunk 2/3: attempt 1/5 failed'));
  });

  it('stops at the failed chunk and never starts the next one', async () => {
    const exec = vi.fn(async (argv: string[]) => {
      const manifest = await readManifest(argv);
      if (manifest[0].key.endsWith('00000002.js')) throw new Error('429: Too Many Requests');
    });

    await expect(
      runBulkUploads(files(6), {
        bucket: 'test-bucket',
        dir: '/assets',
        exec,
        retries: 2,
        chunkSize: 2,
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('429');
    expect(exec).toHaveBeenCalledTimes(3);
  });
});
