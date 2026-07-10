import { describe, expect, it, vi } from 'vitest';
import { assertAllHashed, buildPutArgs, runUploads } from '../scripts/upload-lib.mjs';

describe('assertAllHashed', () => {
  it('passes when all names are hashed', () => {
    const names = [
      'anthropic-messages-DP3-Xd3J.js',
      'index-a1b2c3d4.css',
      'entry-abcd1234.js.map',
      'logo-DEADBEEF.svg',
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

    // 10 files at 2 concurrent = 5 batches × 10ms ≥ 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(execMock).toHaveBeenCalledTimes(10);
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
      })
    ).rejects.toThrow('Always fails');

    expect(execMock).toHaveBeenCalledTimes(2);
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
