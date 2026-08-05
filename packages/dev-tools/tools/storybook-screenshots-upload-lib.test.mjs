// Pins the upload orchestration logic behind an in-memory fake R2 client so
// concurrency, dedup, and manifest-shape handling are verified without
// shelling out to a real `wrangler` process.
import { describe, expect, it } from 'vitest';
import {
  mapWithConcurrency,
  RETRY_BASE_DELAY_MS,
  retryDelayMs,
  uploadManifest,
  uploadOne,
  uploadOneWithRetry,
} from './storybook-screenshots-upload-lib.mjs';

/** In-memory fake standing in for the real wrangler-backed R2 client. */
function fakeR2({ preExisting = new Set() } = {}) {
  const store = new Set(preExisting);
  const calls = [];
  return {
    calls,
    store,
    async exists(bucket, key) {
      calls.push({ op: 'exists', bucket, key });
      return store.has(key);
    },
    async putFile(bucket, key, filePath, contentType) {
      calls.push({ op: 'putFile', bucket, key, filePath, contentType });
      store.add(key);
    },
    async putText(bucket, key, text, contentType) {
      calls.push({ op: 'putText', bucket, key, text, contentType });
      store.add(key);
    },
  };
}

describe('mapWithConcurrency', () => {
  it('runs every item and preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(results).toEqual([60, 20, 40]);
  });

  it('never runs more than `limit` concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('handles an empty item list without spawning any worker', async () => {
    const results = await mapWithConcurrency([], 4, async () => {
      throw new Error('should never be called');
    });
    expect(results).toEqual([]);
  });

  it('handles limit larger than the item count', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(results).toEqual([2, 3]);
  });
});

describe('uploadOne', () => {
  const baseArgs = { outDir: '/out', prefix: 'pr-1/abc', bucket: 'shots', log: () => {} };

  it('uploads a new file to both the PR-scoped key and the hash-scoped key', async () => {
    const r2 = fakeR2();
    const item = { file: 'a.png', contentHash: 'deadbeef1234' };
    const result = await uploadOne(item, { ...baseArgs, r2 });

    expect(result).toEqual({ file: 'a.png', isNew: true });
    const putFileKeys = r2.calls.filter((c) => c.op === 'putFile').map((c) => c.key);
    expect(putFileKeys).toEqual(['pr-1/abc/a.png', 'hashes/deadbeef1234']);
    expect(r2.calls.some((c) => c.op === 'putText')).toBe(false);
  });

  it('writes only a `.ref` pointer when the content hash already exists', async () => {
    const r2 = fakeR2({ preExisting: new Set(['hashes/deadbeef1234']) });
    const item = { file: 'a.png', contentHash: 'deadbeef1234' };
    const result = await uploadOne(item, { ...baseArgs, r2 });

    expect(result).toEqual({ file: 'a.png', isNew: false });
    expect(r2.calls.some((c) => c.op === 'putFile')).toBe(false);
    const putText = r2.calls.find((c) => c.op === 'putText');
    expect(putText).toMatchObject({ key: 'pr-1/abc/a.png.ref', text: 'deadbeef1234' });
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially at the jitter ceiling', () => {
    const atCeiling = () => 1;
    expect(retryDelayMs(1, atCeiling)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(2, atCeiling)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(3, atCeiling)).toBe(RETRY_BASE_DELAY_MS * 4);
  });

  it('applies full jitter, so the delay can be anywhere down to zero', () => {
    expect(retryDelayMs(3, () => 0)).toBe(0);
    expect(retryDelayMs(3, () => 0.5)).toBe(RETRY_BASE_DELAY_MS * 2);
  });
});

describe('uploadOneWithRetry', () => {
  const baseArgs = { outDir: '/out', prefix: 'pr-1/abc', bucket: 'shots', log: () => {} };
  const item = { file: 'a.png', contentHash: 'deadbeef1234' };

  it('retries a rate-limited upload after a backoff and succeeds', async () => {
    const r2 = fakeR2();
    let attempts = 0;
    const failing = {
      ...r2,
      async exists(bucket, key) {
        attempts++;
        if (attempts === 1) throw new Error('429 code 971');
        return r2.exists(bucket, key);
      },
    };
    const sleeps = [];
    const result = await uploadOneWithRetry(item, {
      ...baseArgs,
      r2: failing,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual({ file: 'a.png', isNew: true });
    expect(sleeps).toHaveLength(1);
  });

  it('does not sleep when the first attempt succeeds', async () => {
    const sleeps = [];
    await uploadOneWithRetry(item, {
      ...baseArgs,
      r2: fakeR2(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([]);
  });

  it('rethrows the last error once every attempt is exhausted', async () => {
    const r2 = fakeR2();
    const alwaysFails = {
      ...r2,
      async exists() {
        throw new Error('429 code 971');
      },
    };
    const sleeps = [];
    await expect(
      uploadOneWithRetry(item, {
        ...baseArgs,
        r2: alwaysFails,
        retries: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toThrow('429 code 971');
    expect(sleeps).toHaveLength(2);
  });
});

describe('uploadManifest', () => {
  it('returns an empty list and skips all R2 calls for a zero-shot manifest', async () => {
    const r2 = fakeR2();
    const newUploads = await uploadManifest(
      { shots: [] },
      { outDir: '/out', prefix: 'pr-1/abc', bucket: 'shots', r2 }
    );
    expect(newUploads).toEqual([]);
    expect(r2.calls).toEqual([]);
  });

  it('returns only the newly-uploaded filenames, excluding cache hits', async () => {
    const r2 = fakeR2({ preExisting: new Set(['hashes/cached-hash']) });
    const manifest = {
      shots: [
        { file: 'new.png', contentHash: 'new-hash' },
        { file: 'cached.png', contentHash: 'cached-hash' },
      ],
    };
    const newUploads = await uploadManifest(manifest, {
      outDir: '/out',
      prefix: 'pr-1/abc',
      bucket: 'shots',
      r2,
      concurrency: 4,
    });
    expect(newUploads).toEqual(['new.png']);
  });

  it('uploads every shot exactly once even under concurrency', async () => {
    const r2 = fakeR2();
    const shots = Array.from({ length: 20 }, (_, i) => ({
      file: `s${i}.png`,
      contentHash: `hash-${i}`,
    }));
    const newUploads = await uploadManifest(
      { shots },
      { outDir: '/out', prefix: 'pr-1/abc', bucket: 'shots', r2, concurrency: 5 }
    );
    expect(newUploads).toHaveLength(20);
    expect(new Set(newUploads).size).toBe(20);
    // Each new file: exists + 2 putFile calls (PR-scoped + hash-scoped).
    expect(r2.calls.filter((c) => c.op === 'putFile')).toHaveLength(40);
  });
});
