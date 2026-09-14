import { createLogger } from '../base/logger.js';
import type { EspeakPhonemize } from './kokoro-phonemize.js';

const log = createLogger('speech:espeak');

export const ESPEAK_DIST_VFS_PATH = '/workspace/node_modules/espeak-ng/dist/';

export const ESPEAK_GLUE_FILE = 'espeak-ng.js';
export const ESPEAK_WASM_FILE = 'espeak-ng.wasm';

interface EspeakModule {
  FS: { readFile(path: string, opts: { encoding: 'utf8' }): string };
}

export type EspeakFactory = (options: {
  arguments: string[];
  locateFile?: (path: string) => string;
}) => Promise<EspeakModule>;

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
    let timer: ReturnType<typeof setTimeout>;
    const armTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => done(() => reject(new Error(`ENOENT: ${path} (timed out)`))), 30000);
    };
    armTimeout();
    const listener = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; id?: string; content?: unknown; error?: string };
      if (!data || data.id !== id) return;

      if (data.type === 'preview-vfs-start') {
        armTimeout();
        return;
      }
      if (data.type !== 'preview-vfs-response') return;
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

export function setEspeakFactoryLoaderForTests(
  loader: () => Promise<{ factory: EspeakFactory; locateFile?: (path: string) => string }>
): void {
  factoryLoader = loader;
  phonemizePromise = null;
}

export function resetEspeakForTests(): void {
  factoryLoader = loadEspeakFactoryFromVfs;
  phonemizePromise = null;
}
