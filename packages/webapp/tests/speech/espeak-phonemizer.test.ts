import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
