import { describe, expect, it, vi } from 'vitest';
import {
  assertAllHashed,
  buildPutArgs,
  RETRY_BASE_DELAY_MS,
  retryDelayMs,
  runUploads,
} from '../scripts/upload-lib.mjs';

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

  it('throws when a name lacks a hash', () => {
    const names = [
      'anthropic-messages-DP3-Xd3J.js',
      'index.html', // no hash
      'entry-abcd1234.js.map',
    ];
    expect(() => assertAllHashed(names)).toThrow();
  });

  it('throws when any name is unhashed', () => {
    const names = ['foo.js']; // no hash
    expect(() => assertAllHashed(names)).toThrow();
  });
});

describe('buildPutArgs', () => {
  it('yields the correct argv for wrangler r2 object put', () => {
    const bucket = 'slicc-asset-archive';
    const file = 'index-a1b2c3d4.css';

    const args = buildPutArgs(bucket, file, 'dist/ui/assets');

    expect(args).toEqual([
      'wrangler',
      'r2',
      'object',
      'put',
      'slicc-asset-archive/assets/index-a1b2c3d4.css',
      '--file',
      'dist/ui/assets/index-a1b2c3d4.css',
      '--content-type',
      'text/css',
      '--remote',
    ]);
  });

  it('handles .js files', () => {
    const args = buildPutArgs('bucket', 'app-abc1234d.js', 'dist/ui/assets');
    expect(args).toContain('--content-type');
    expect(args).toContain('text/javascript');
    expect(args).toContain('--remote'); // required — wrangler r2 put defaults to local
  });

  it('handles .wasm files', () => {
    const args = buildPutArgs('bucket', 'module-xyz78901.wasm');
    expect(args).toContain('--content-type');
    expect(args).toContain('application/wasm');
  });
});

describe('runUploads', () => {
  it('calls exec for each file with the correct args', async () => {
    const execMock = vi.fn().mockResolvedValue(undefined);
    const files = ['index-a1b2c3d4.css', 'app-def2g5h6.js'];

    await runUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
    });

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(1, [
      'wrangler',
      'r2',
      'object',
      'put',
      'test-bucket/assets/index-a1b2c3d4.css',
      '--file',
      '/assets/index-a1b2c3d4.css',
      '--content-type',
      'text/css',
      '--remote',
    ]);
  });

  it('respects concurrency cap', async () => {
    const execMock = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 10);
        })
    );
    const files = Array.from({ length: 10 }, (_, i) => `file${i}-abc123def${i}.js`);

    const start = Date.now();
    await runUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      concurrency: 2,
    });
    const elapsed = Date.now() - start;

    // 10 files at 2 concurrent, 10ms each ≥ 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(execMock).toHaveBeenCalledTimes(10);
  });

  // Fixed-size batches used to be a barrier: one file backing off held its
  // whole batch's slots idle. Rolling workers keep every slot busy.
  it('keeps the other slots busy while one file backs off', async () => {
    const files = Array.from({ length: 6 }, (_, i) => `file${i}-abc123def${i}.js`);
    let releaseSlow = () => {};
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const finished: string[] = [];
    const execMock = vi.fn(async (argv: string[]) => {
      const objectPath = argv[4];
      if (objectPath.endsWith('file0-abc123def0.js')) {
        await slowDone;
      }
      finished.push(objectPath);
    });

    const run = runUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      concurrency: 2,
    });

    // Everything except the stalled file drains through the free slot.
    await vi.waitFor(() => expect(finished).toHaveLength(files.length - 1));
    releaseSlow();
    await run;

    expect(execMock).toHaveBeenCalledTimes(files.length);
  });

  it('retries on exec failure', async () => {
    let callCount = 0;
    const execMock = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Temporary failure');
      }
    });
    const files = ['file-abc12345.js'];

    await runUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
      retries: 3,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it('throws after max retries exceeded', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('Always fails'));
    const files = ['file-abc12345.js'];

    await expect(
      runUploads(files, {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
        retries: 2,
        sleep: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('Always fails');

    expect(execMock).toHaveBeenCalledTimes(2);
  });

  // Regression: retries used to re-fire instantly, so a burst of R2 429s
  // (error 971) exhausted every attempt within milliseconds and failed the
  // deploy gate.
  it('backs off between retries instead of re-firing instantly', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('429: Too Many Requests'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      runUploads(['file-abc12345.js'], {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
        retries: 4,
        sleep,
      })
    ).rejects.toThrow('429: Too Many Requests');

    // One backoff between each pair of attempts, none after the last.
    expect(sleep).toHaveBeenCalledTimes(3);
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses a real timer backoff when no sleep is injected', async () => {
    const execMock = vi.fn().mockRejectedValue(new Error('429: Too Many Requests'));

    const start = Date.now();
    await expect(
      runUploads(['file-abc12345.js'], {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
        retries: 2,
      })
    ).rejects.toThrow('429: Too Many Requests');

    // Full jitter can round to 0ms, so only the attempt count is asserted.
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeLessThan(RETRY_BASE_DELAY_MS * 4);
  });

  it('does not sleep when the first attempt succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);

    await runUploads(['file-abc12345.js'], {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: vi.fn().mockResolvedValue(undefined),
      retries: 5,
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('re-puts every file (no skip)', async () => {
    const execMock = vi.fn().mockResolvedValue(undefined);
    const files = ['a-abc12345.js', 'b-def67890.css', 'c-ghi11121.wasm'];

    await runUploads(files, {
      bucket: 'test-bucket',
      dir: '/assets',
      exec: execMock,
    });

    expect(execMock).toHaveBeenCalledTimes(3);
    // Verify all files were uploaded (in order)
    const fileArgs = execMock.mock.calls.map((call) => call[0][4]); // the objectPath arg
    expect(fileArgs).toEqual([
      'test-bucket/assets/a-abc12345.js',
      'test-bucket/assets/b-def67890.css',
      'test-bucket/assets/c-ghi11121.wasm',
    ]);
  });

  it('throws on hash invariant violation', async () => {
    const execMock = vi.fn();
    const files = ['unhashed.js', 'valid-abc12345.js'];

    await expect(
      runUploads(files, {
        bucket: 'test-bucket',
        dir: '/assets',
        exec: execMock,
      })
    ).rejects.toThrow();

    expect(execMock).not.toHaveBeenCalled();
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
