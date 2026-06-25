import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBlobBackedEspeakFactory,
  type EspeakFactory,
  getEspeakPhonemize,
  phonemizeWithEspeak,
  resetEspeakForTests,
  setEspeakFactoryLoaderForTests,
} from '../../src/speech/espeak-phonemizer.js';

/** A fake espeak-ng emscripten module factory: records the args it was called
 *  with and returns the canned phoneme `output` from `FS.readFile`. */
function fakeFactory(output: string): {
  factory: EspeakFactory;
  calls: Array<{ arguments: string[] }>;
} {
  const calls: Array<{ arguments: string[] }> = [];
  const factory: EspeakFactory = async (opts) => {
    calls.push({ arguments: opts.arguments });
    return { FS: { readFile: () => output } };
  };
  return { factory, calls };
}

describe('phonemizeWithEspeak', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes UTF-8 + IPA CLI args with the language and text, returns IPA lines', async () => {
    const { factory, calls } = fakeFactory('ˈola\n\nˈmundo\n');
    const out = await phonemizeWithEspeak(factory, 'Hola mundo', 'es');
    expect(out).toEqual(['ˈola', 'ˈmundo']);
    const args = calls[0].arguments;
    expect(args).toContain('-b=1');
    expect(args).toContain('--ipa');
    expect(args).toContain('-q');
    expect(args).toEqual(expect.arrayContaining(['-v', 'es']));
    expect(args.at(-1)).toBe('Hola mundo');
  });

  it('forwards locateFile when provided', async () => {
    const factory = vi.fn(async () => ({
      FS: { readFile: () => 'p' },
    })) as unknown as EspeakFactory;
    const locateFile = (p: string): string => `blob:${p}`;
    await phonemizeWithEspeak(factory, 'ciao', 'it', locateFile);
    expect((factory as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].locateFile).toBe(
      locateFile
    );
  });

  it('revokes the per-call wasm blob URL after the factory resolves', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wasm');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const inner = vi.fn(async (opts) => {
      expect(opts.locateFile?.('espeak-ng.wasm')).toBe('blob:wasm');
      expect(opts.locateFile?.('other.data')).toBe('other.data');
      return { FS: { readFile: () => 'p\n' } };
    }) as unknown as EspeakFactory;

    const factory = createBlobBackedEspeakFactory(inner, new Uint8Array([1, 2, 3]));
    expect(await phonemizeWithEspeak(factory, 'hola', 'es')).toEqual(['p']);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wasm');
  });

  it('revokes the wasm blob URL when the factory rejects', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wasm');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const inner = vi.fn(async () => {
      throw new Error('instantiate failed');
    }) as unknown as EspeakFactory;

    const factory = createBlobBackedEspeakFactory(inner, new Uint8Array([1]));
    await expect(phonemizeWithEspeak(factory, 'hola', 'es')).rejects.toThrow(/instantiate failed/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wasm');
  });
});

describe('getEspeakPhonemize', () => {
  afterEach(() => resetEspeakForTests());

  it('loads the factory once and reuses it across calls', async () => {
    const { factory } = fakeFactory('fɔ̃\n');
    const loader = vi.fn(async () => ({ factory }));
    setEspeakFactoryLoaderForTests(loader);
    const phonemize = await getEspeakPhonemize();
    const again = await getEspeakPhonemize();
    expect(again).toBe(phonemize);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await phonemize('bonjour', 'fr-fr')).toEqual(['fɔ̃']);
  });

  it('resets the memo on a failed load so a retry can succeed', async () => {
    const failing = vi.fn(async () => {
      throw new Error('vfs read failed');
    });
    setEspeakFactoryLoaderForTests(failing as never);
    await expect(getEspeakPhonemize()).rejects.toThrow(/vfs read failed/);
    const { factory } = fakeFactory('a\n');
    setEspeakFactoryLoaderForTests(async () => ({ factory }));
    await expect(getEspeakPhonemize()).resolves.toBeTypeOf('function');
  });
});
