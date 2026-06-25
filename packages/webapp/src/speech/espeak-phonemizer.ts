/**
 * Multilingual espeak-ng phonemizer for Kokoro's non-English voices.
 *
 * The `phonemizer` package kokoro-js bundles is English-only (its inlined
 * espeak-ng-data carries just `en_dict` + the shared `phon*` tables). To
 * phonemize es/fr/it/hi/pt we load the full `espeak-ng` npm package (~17 MB
 * wasm with ALL language data embedded) — the path hexgrad/kokoro #65
 * recommends. Like `onnxruntime-web`, it is NOT bundled: it is staged into the
 * VFS on demand (`ensure-speech-assets.ts`) and loaded here from VFS bytes.
 *
 * `phonemizeWithEspeak` is the PURE core (runs the espeak CLI args against an
 * injected module factory, reads the phoneme output) and is unit-tested with a
 * fake factory. `getEspeakPhonemize` memoizes the real VFS-loaded factory.
 *
 * Cross-runtime: standalone / CLI is primary. The extension float can't
 * dynamic-import a VFS blob-URL ESM module under MV3 CSP, so on-device
 * non-English there needs the glue bundled into the extension build — a
 * follow-up; it degrades to Web Speech via the routing task until then.
 */

import { createLogger } from '../core/logger.js';
import type { EspeakPhonemize } from './kokoro-phonemize.js';

const log = createLogger('speech:espeak');

/** Where `ipk add espeak-ng` materializes the package in the VFS. */
export const ESPEAK_DIST_VFS_PATH = '/workspace/node_modules/espeak-ng/dist/';
/** The glue (ESM) + wasm dist files espeak-ng ships. */
export const ESPEAK_GLUE_FILE = 'espeak-ng.js';
export const ESPEAK_WASM_FILE = 'espeak-ng.wasm';

/** Minimal slice of an instantiated espeak-ng emscripten module. */
interface EspeakModule {
  FS: { readFile(path: string, opts: { encoding: 'utf8' }): string };
}
/** The espeak-ng default export: a CLI-style emscripten module factory. */
export type EspeakFactory = (options: {
  arguments: string[];
  locateFile?: (path: string) => string;
}) => Promise<EspeakModule>;

/**
 * Phonemize `text` in `espeakLang` via the espeak-ng CLI surface: emit IPA
 * (UTF-8 input via `-b=1` so accents / Devanagari survive) to an in-FS file,
 * then read it back. Returns IPA lines (one per clause) with blanks dropped —
 * the same shape as the `phonemizer` package's `phonemize`. Pure given
 * `factory` (mock it in tests).
 */
export async function phonemizeWithEspeak(
  factory: EspeakFactory,
  text: string,
  espeakLang: string,
  locateFile?: (path: string) => string
): Promise<string[]> {
  const outFile = 'phonemes.txt';
  const espeak = await factory({
    arguments: ['-q', '-b=1', '--ipa', '-v', espeakLang, '--phonout', outFile, text],
    ...(locateFile ? { locateFile } : {}),
  });
  const raw = espeak.FS.readFile(outFile, { encoding: 'utf8' });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Wrap an espeak factory with a per-invocation wasm blob URL. Emscripten only
 * needs the URL while the factory promise is instantiating the module, so each
 * call can revoke it immediately after success or failure. */
export function createBlobBackedEspeakFactory(
  factory: EspeakFactory,
  wasm: Uint8Array
): EspeakFactory {
  return async (options) => {
    const wasmUrl = URL.createObjectURL(
      new Blob([new Uint8Array(wasm)], { type: 'application/wasm' })
    );
    try {
      const locateFile = (path: string): string => {
        if (path.endsWith('.wasm')) return wasmUrl;
        return options.locateFile?.(path) ?? path;
      };
      return await factory({ ...options, locateFile });
    } finally {
      URL.revokeObjectURL(wasmUrl);
    }
  };
}

/** Read VFS bytes via the page-side `preview-vfs` responder (same wire the ort
 *  wasm load uses) — bypassing the preview SW. Page/offscreen realm only. */
function readVfsBytes(path: string): Promise<Uint8Array> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.reject(new Error(`Cannot read VFS path ${path}: BroadcastChannel unavailable`));
  }
  const channel = new BroadcastChannel('preview-vfs');
  const id = `espeak-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<Uint8Array>((resolve, reject) => {
    const done = (cb: () => void): void => {
      channel.removeEventListener('message', listener);
      channel.close();
      cb();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`ENOENT: ${path} (timed out)`))),
      30000
    );
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; id?: string; content?: unknown; error?: string };
      if (data?.type !== 'preview-vfs-response' || data.id !== id) return;
      clearTimeout(timer);
      if (typeof data.error === 'string') {
        done(() => reject(new Error(data.error)));
      } else if (data.content instanceof Uint8Array) {
        const c = data.content;
        done(() => resolve(c));
      } else if (typeof data.content === 'string') {
        const c = data.content;
        done(() => resolve(new TextEncoder().encode(c)));
      } else {
        done(() => reject(new Error(`Empty preview-vfs response for ${path}`)));
      }
    };
    channel.addEventListener('message', listener);
    channel.postMessage({ type: 'preview-vfs-read', id, path, asText: false });
  });
}

/** Default real loader: read the staged glue + wasm from VFS, blob-URL them,
 *  and dynamic-import the glue's emscripten factory with `locateFile` pointed
 *  at the wasm blob. Browser realm only. */
async function loadEspeakFactoryFromVfs(): Promise<{
  factory: EspeakFactory;
}> {
  const [glue, wasm] = await Promise.all([
    readVfsBytes(`${ESPEAK_DIST_VFS_PATH}${ESPEAK_GLUE_FILE}`),
    readVfsBytes(`${ESPEAK_DIST_VFS_PATH}${ESPEAK_WASM_FILE}`),
  ]);
  const glueUrl = URL.createObjectURL(
    new Blob([new Uint8Array(glue)], { type: 'text/javascript' })
  );
  try {
    const mod = (await import(/* @vite-ignore */ glueUrl)) as { default: EspeakFactory };
    return { factory: createBlobBackedEspeakFactory(mod.default, wasm) };
  } finally {
    URL.revokeObjectURL(glueUrl);
  }
}

let factoryLoader: () => Promise<{
  factory: EspeakFactory;
  locateFile?: (path: string) => string;
}> = loadEspeakFactoryFromVfs;
let phonemizePromise: Promise<EspeakPhonemize> | null = null;

/**
 * The memoized multilingual `EspeakPhonemize`. First call loads the staged
 * espeak-ng wasm; subsequent calls reuse it. A failed load resets so a later
 * call can retry.
 */
export function getEspeakPhonemize(): Promise<EspeakPhonemize> {
  if (!phonemizePromise) {
    phonemizePromise = factoryLoader().then(
      ({ factory, locateFile }) => {
        log.info('espeak-ng multilingual phonemizer loaded');
        return (text: string, lang: string) => phonemizeWithEspeak(factory, text, lang, locateFile);
      },
      (err) => {
        phonemizePromise = null;
        log.error('espeak-ng load failed', err);
        throw err;
      }
    );
  }
  return phonemizePromise;
}

/** Test seam: inject a fake factory loader (and reset the memo). */
export function setEspeakFactoryLoaderForTests(
  loader: () => Promise<{ factory: EspeakFactory; locateFile?: (path: string) => string }>
): void {
  factoryLoader = loader;
  phonemizePromise = null;
}

/** Test-only: restore the real VFS loader + drop the memo. */
export function resetEspeakForTests(): void {
  factoryLoader = loadEspeakFactoryFromVfs;
  phonemizePromise = null;
}
