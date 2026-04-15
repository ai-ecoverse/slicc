import { describe, it, expect } from 'vitest';

import {
  SHIMMED_BUILTINS,
  UNAVAILABLE_BUILTINS,
  generateShimCode,
} from '../../src/ui/preview-sw-shims.js';

describe('preview-sw-shims', () => {
  describe('SHIMMED_BUILTINS', () => {
    it('contains fs, process, and buffer', () => {
      expect(SHIMMED_BUILTINS).toContain('fs');
      expect(SHIMMED_BUILTINS).toContain('process');
      expect(SHIMMED_BUILTINS).toContain('buffer');
      expect(SHIMMED_BUILTINS).toHaveLength(3);
    });
  });

  describe('UNAVAILABLE_BUILTINS', () => {
    it('contains expected networking and system modules', () => {
      const expected = [
        'http',
        'https',
        'net',
        'tls',
        'dgram',
        'dns',
        'cluster',
        'worker_threads',
        'child_process',
        'crypto',
        'os',
        'stream',
        'zlib',
        'vm',
        'v8',
        'perf_hooks',
        'readline',
        'repl',
        'tty',
        'inspector',
      ];
      for (const mod of expected) {
        expect(UNAVAILABLE_BUILTINS).toContain(mod);
      }
      expect(UNAVAILABLE_BUILTINS).toHaveLength(expected.length);
    });
  });

  describe('generateShimCode', () => {
    describe('fs shim', () => {
      it('returns module code that exports all fs functions', () => {
        const code = generateShimCode('fs');
        expect(code).not.toBeNull();
        expect(code).toContain('globalThis.__slicc_fs');
        expect(code).toContain('export const readFile');
        expect(code).toContain('export const readFileBinary');
        expect(code).toContain('export const writeFile');
        expect(code).toContain('export const writeFileBinary');
        expect(code).toContain('export const readDir');
        expect(code).toContain('export const exists');
        expect(code).toContain('export const stat');
        expect(code).toContain('export const mkdir');
        expect(code).toContain('export const rm');
        expect(code).toContain('export const fetchToFile');
        expect(code).toContain('export default _fs');
      });
    });

    describe('process shim', () => {
      it('returns module code that exports process properties', () => {
        const code = generateShimCode('process');
        expect(code).not.toBeNull();
        expect(code).toContain('globalThis.__slicc_process');
        expect(code).toContain('export const argv');
        expect(code).toContain('export const env');
        expect(code).toContain('export const cwd');
        expect(code).toContain('export const exit');
        expect(code).toContain('export const stdout');
        expect(code).toContain('export const stderr');
        expect(code).toContain('export default _process');
      });
    });

    describe('buffer shim', () => {
      it('returns module code that exports Buffer', () => {
        const code = generateShimCode('buffer');
        expect(code).not.toBeNull();
        expect(code).toContain('globalThis.Buffer');
        expect(code).toContain('export const Buffer');
        expect(code).toContain('export default');
      });
    });

    describe('unavailable builtins', () => {
      it('returns error-throwing code for http with fetch hint', () => {
        const code = generateShimCode('http');
        expect(code).not.toBeNull();
        expect(code).toContain('throw new Error');
        expect(code).toContain('"http"');
        expect(code).toContain('not available in the browser');
        expect(code).toContain('fetch()');
      });

      it('returns error-throwing code for https with fetch hint', () => {
        const code = generateShimCode('https');
        expect(code).not.toBeNull();
        expect(code).toContain('throw new Error');
        expect(code).toContain('fetch()');
      });

      it('returns error-throwing code for child_process with bash hint', () => {
        const code = generateShimCode('child_process');
        expect(code).not.toBeNull();
        expect(code).toContain('throw new Error');
        expect(code).toContain('bash tool');
      });

      it('returns error-throwing code for crypto with Web Crypto hint', () => {
        const code = generateShimCode('crypto');
        expect(code).not.toBeNull();
        expect(code).toContain('throw new Error');
        expect(code).toContain('Web Crypto');
      });

      it('returns error-throwing code for modules without specific hints', () => {
        const code = generateShimCode('repl');
        expect(code).not.toBeNull();
        expect(code).toContain('throw new Error');
        expect(code).toContain('"repl"');
        expect(code).toContain('not available in the browser');
      });

      it('returns error-throwing code for all unavailable builtins', () => {
        for (const mod of UNAVAILABLE_BUILTINS) {
          const code = generateShimCode(mod);
          expect(code).not.toBeNull();
          expect(code).toContain('throw new Error');
        }
      });
    });

    describe('unknown modules', () => {
      it('returns null for unknown module names', () => {
        expect(generateShimCode('express')).toBeNull();
        expect(generateShimCode('lodash')).toBeNull();
        expect(generateShimCode('react')).toBeNull();
        expect(generateShimCode('')).toBeNull();
        expect(generateShimCode('foo-bar')).toBeNull();
      });
    });
  });
});
