import 'fake-indexeddb/auto';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import {
  ensureSpeechAssetsStaged,
  type SpeechAssetProgress,
} from '../../src/speech/ensure-speech-assets.js';
import { ORT_DIST_VFS_PATH, ORT_WASM_DIST_FILES } from '../../src/speech/transformers-env.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-ensure-speech-${dbCounter++}`, wipe: true });
}
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Pre-stage every ort dist file so the network install fast-path is skipped. */
async function stageOrt(fs: VirtualFS): Promise<void> {
  for (const f of ORT_WASM_DIST_FILES) {
    await fs.mkdir(ORT_DIST_VFS_PATH, { recursive: true });
    await fs.writeFile(`${ORT_DIST_VFS_PATH}${f}`, bytes('wasm'));
  }
}

function hfFetch(files: Record<string, Uint8Array>): SecureFetch {
  return (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    if (url.includes('/api/models/')) {
      const entries = Object.entries(files).map(([path, b]) => ({
        type: 'file',
        path,
        size: b.byteLength,
      }));
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: bytes(JSON.stringify(entries)),
        url,
      };
    }
    const m = url.match(/\/resolve\/[^/]+\/(.+)$/);
    const body = m ? files[m[1]] : undefined;
    if (!body) return { status: 404, statusText: 'Not Found', headers: {}, body: bytes(''), url };
    return { status: 200, statusText: 'OK', headers: {}, body, url };
  }) as unknown as SecureFetch;
}

const REPO = 'owner/model';

let savedChrome: unknown;
beforeEach(() => {
  savedChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = undefined;
});
afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = savedChrome;
});

describe('ensureSpeechAssetsStaged', () => {
  it('stages weight repos (ort already present) and streams per-asset progress', async () => {
    const fs = await newFs();
    await stageOrt(fs);
    const fetch = hfFetch({ 'config.json': bytes('{}'), 'model.onnx': bytes('abcd') });
    const progress: SpeechAssetProgress[] = [];
    const result = await ensureSpeechAssetsStaged({ fs, fetch, repos: [REPO] }, (p) =>
      progress.push(p)
    );
    expect(result).toMatchObject({ skipped: false, ortStaged: false });
    expect(result.repos).toEqual([{ repo: REPO, downloaded: 2, skipped: 0 }]);
    expect(await fs.exists(`/workspace/models/${REPO}/model.onnx`)).toBe(true);
    expect(progress.some((p) => p.asset === 'onnxruntime-web' && p.phase === 'present')).toBe(true);
    const listing = progress.find((p) => p.asset === REPO && p.phase === 'listing');
    expect(listing).toMatchObject({ filesTotal: 2, bytesTotal: 6 });
  });

  it('is a fast no-op on a second call (weights byte-skipped)', async () => {
    const fs = await newFs();
    await stageOrt(fs);
    const fetch = hfFetch({ 'config.json': bytes('{}'), 'model.onnx': bytes('abcd') });
    await ensureSpeechAssetsStaged({ fs, fetch, repos: [REPO] });
    const second = await ensureSpeechAssetsStaged({ fs, fetch, repos: [REPO] });
    expect(second.repos).toEqual([{ repo: REPO, downloaded: 0, skipped: 2 }]);
    expect(second.ortStaged).toBe(false);
  });

  it('early-returns on the extension float without touching the network', async () => {
    const fs = await newFs();
    let called = false;
    const fetch: SecureFetch = (async () => {
      called = true;
      throw new Error('should not fetch');
    }) as unknown as SecureFetch;
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'ext-id' } };
    const result = await ensureSpeechAssetsStaged({ fs, fetch, repos: [REPO] });
    expect(result).toEqual({ skipped: true, ortStaged: false, repos: [] });
    expect(called).toBe(false);
  });

  it('rejects with a host-named error when HF is unreachable', async () => {
    const fs = await newFs();
    await stageOrt(fs);
    const failing: SecureFetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as SecureFetch;
    await expect(ensureSpeechAssetsStaged({ fs, fetch: failing, repos: [REPO] })).rejects.toThrow(
      /huggingface\.co/
    );
  });

  it('rejects with an actionable error when the ort runtime install fails', async () => {
    const fs = await newFs();
    // ort dist absent → installPackages runs; the npm registry fetch fails.
    const failing: SecureFetch = (async (url: string): Promise<FetchResult> => {
      throw new TypeError(`Failed to fetch ${url}`);
    }) as unknown as SecureFetch;
    await expect(ensureSpeechAssetsStaged({ fs, fetch: failing, repos: [REPO] })).rejects.toThrow(
      /failed to stage onnxruntime-web/
    );
  });
});
