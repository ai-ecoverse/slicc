import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAllHashed,
  buildBulkPutArgs,
  buildManifestGroups,
  RETRY_BASE_DELAY_MS,
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

    expect(result).toEqual({ groups: 3, invocations: 3, retries: 0 });
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

    expect(result).toEqual({ groups: 1, invocations: 3, retries: 2 });
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
    ).resolves.toEqual({ groups: 0, invocations: 0, retries: 0 });
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
    expect(Date.now() - start).toBeLessThan(RETRY_BASE_DELAY_MS * 4);
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
    const noJitter = () => 1;
    expect(retryDelayMs(1, noJitter)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(2, noJitter)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(3, noJitter)).toBe(RETRY_BASE_DELAY_MS * 4);
  });

  it('applies full jitter so concurrent retries do not fire in lockstep', () => {
    expect(retryDelayMs(3, () => 0)).toBe(0);
    expect(retryDelayMs(3, () => 0.5)).toBe(RETRY_BASE_DELAY_MS * 2);
  });
});
