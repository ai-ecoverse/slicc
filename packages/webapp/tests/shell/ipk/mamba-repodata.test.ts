import { describe, expect, it } from 'vitest';
import {
  compareCondaVersions,
  isVirtualCondaDep,
  parseCondaSpec,
  type RepodataIndex,
  resolveCondaPackage,
} from '../../../src/shell/ipk/mamba-repodata.js';

describe('mamba-repodata', () => {
  it('parses name and name=version specs', () => {
    expect(parseCondaSpec('zlib')).toEqual({ name: 'zlib', version: '' });
    expect(parseCondaSpec('zlib=1.3.1')).toEqual({ name: 'zlib', version: '1.3.1' });
    expect(parseCondaSpec('zlib==1.3.1')).toEqual({ name: 'zlib', version: '1.3.1' });
    expect(() => parseCondaSpec('')).toThrow(/required/);
    expect(() => parseCondaSpec('-g')).toThrow(/invalid/);
  });

  it('treats emscripten-abi and __* as virtual deps', () => {
    expect(isVirtualCondaDep('emscripten-abi >=4,<5.0a0')).toBe(true);
    expect(isVirtualCondaDep('__unix')).toBe(true);
    expect(isVirtualCondaDep('zlib')).toBe(false);
  });

  it('compares conda versions numerically', () => {
    expect(compareCondaVersions('1.3.1', '1.3.2')).toBeLessThan(0);
    expect(compareCondaVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('resolves the newest build from an injected index', async () => {
    const index: RepodataIndex = {
      packages: {
        'zlib-1.3.1-h_2.tar.bz2': {
          name: 'zlib',
          version: '1.3.1',
          build: 'h_2',
          build_number: 2,
          depends: ['emscripten-abi >=4,<5.0a0'],
        },
        'zlib-1.3.1-h_3.tar.bz2': {
          name: 'zlib',
          version: '1.3.1',
          build: 'h_3',
          build_number: 3,
          depends: ['emscripten-abi >=4,<5.0a0'],
        },
        'zlib-1.3.2-h_0.tar.bz2': {
          name: 'zlib',
          version: '1.3.2',
          build: 'h_0',
          build_number: 0,
        },
      },
    };
    const indexes = new Map<string, RepodataIndex>([
      ['https://repo.prefix.dev/emscripten-forge-4x|emscripten-wasm32', index],
    ]);
    const fetch = async () => {
      throw new Error('network should not be used');
    };
    const latest = await resolveCondaPackage('zlib', {
      fetch: fetch as never,
      channels: ['https://repo.prefix.dev/emscripten-forge-4x'],
      includeNoarch: false,
      indexes,
    });
    expect(latest.version).toBe('1.3.2');
    expect(latest.filename).toBe('zlib-1.3.2-h_0.tar.bz2');

    const pinned = await resolveCondaPackage('zlib=1.3.1', {
      fetch: fetch as never,
      channels: ['https://repo.prefix.dev/emscripten-forge-4x'],
      includeNoarch: false,
      indexes,
    });
    expect(pinned.build).toBe('h_3');
  });

  it('skips .conda artifacts when a .tar.bz2 is available', async () => {
    const index: RepodataIndex = {
      packages: {
        'zlib-1.3.1-h_1.tar.bz2': {
          name: 'zlib',
          version: '1.3.1',
          build: 'h_1',
          build_number: 1,
        },
      },
      'packages.conda': {
        'zlib-1.3.1-h_9.conda': {
          name: 'zlib',
          version: '1.3.1',
          build: 'h_9',
          build_number: 9,
        },
      },
    };
    const channel = 'https://repo.prefix.dev/emscripten-forge-4x';
    const indexes = new Map<string, RepodataIndex>([[`${channel}|emscripten-wasm32`, index]]);
    const picked = await resolveCondaPackage('zlib=1.3.1', {
      fetch: (async () => {
        throw new Error('network should not be used');
      }) as never,
      channels: [channel],
      includeNoarch: false,
      indexes,
    });
    expect(picked.filename).toBe('zlib-1.3.1-h_1.tar.bz2');
  });

  it('prefers an earlier channel over a higher build on a later channel', async () => {
    const forge = 'https://repo.prefix.dev/emscripten-forge-4x';
    const condaForge = 'https://repo.prefix.dev/conda-forge';
    const indexes = new Map<string, RepodataIndex>([
      [
        `${forge}|emscripten-wasm32`,
        {
          packages: {
            'zlib-1.3.1-h_1.tar.bz2': {
              name: 'zlib',
              version: '1.3.1',
              build: 'h_1',
              build_number: 1,
            },
          },
        },
      ],
      [
        `${condaForge}|emscripten-wasm32`,
        {
          packages: {
            'zlib-1.3.1-h_9.tar.bz2': {
              name: 'zlib',
              version: '1.3.1',
              build: 'h_9',
              build_number: 9,
            },
          },
        },
      ],
    ]);
    const picked = await resolveCondaPackage('zlib=1.3.1', {
      fetch: (async () => {
        throw new Error('network should not be used');
      }) as never,
      channels: [forge, condaForge],
      includeNoarch: false,
      indexes,
    });
    expect(picked.channel).toBe(forge);
    expect(picked.build).toBe('h_1');
  });
});
