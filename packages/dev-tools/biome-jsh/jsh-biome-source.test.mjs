import { describe, expect, it } from 'vitest';
import {
  biomeVirtualPath,
  isLintableFile,
  JSH_WRAP_PREFIX,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  JSH_WRAP_PREFIX_LINE_COUNT,
  JSH_WRAP_SUFFIX,
  shouldWrapForBiome,
  unwrapFormattedJsh,
  wrapJshForBiome,
} from './jsh-biome-source.mjs';

describe('isLintableFile', () => {
  it('accepts source + shell-script extensions, case-insensitively', () => {
    for (const ext of ['js', 'ts', 'tsx', 'json', 'jsonc', 'css', 'jsh', 'bsh', 'JSH', 'Bsh']) {
      expect(isLintableFile(`a.${ext}`)).toBe(true);
    }
  });
  it('rejects unknown / extension-less paths', () => {
    expect(isLintableFile('a.md')).toBe(false);
    expect(isLintableFile('a.png')).toBe(false);
    expect(isLintableFile('Makefile')).toBe(false);
  });
});

describe('biomeVirtualPath', () => {
  it('maps .jsh/.bsh to a .js parser path and leaves others alone', () => {
    expect(biomeVirtualPath('/w/tool.jsh')).toBe('/w/tool.js');
    expect(biomeVirtualPath('/w/panel.bsh')).toBe('/w/panel.js');
    expect(biomeVirtualPath('/w/mod.ts')).toBe('/w/mod.ts');
  });
});

describe('shouldWrapForBiome', () => {
  it('is true only for shell scripts', () => {
    expect(shouldWrapForBiome('a.jsh')).toBe(true);
    expect(shouldWrapForBiome('a.bsh')).toBe(true);
    expect(shouldWrapForBiome('a.js')).toBe(false);
    expect(shouldWrapForBiome('a.ts')).toBe(false);
  });
});

describe('wrap constants', () => {
  it('prefix is one newline-terminated line at column 0', () => {
    expect(JSH_WRAP_PREFIX.endsWith('\n')).toBe(true);
    expect(JSH_WRAP_PREFIX_LINE_COUNT).toBe(1);
    expect(JSH_WRAP_PREFIX_BYTE_LENGTH).toBe(new TextEncoder().encode(JSH_WRAP_PREFIX).length);
  });
});

describe('wrap/unwrap round-trip', () => {
  it('wrapJshForBiome brackets the body without indenting it', () => {
    expect(wrapJshForBiome('return 1;')).toBe(`${JSH_WRAP_PREFIX}return 1;${JSH_WRAP_SUFFIX}`);
  });

  it('unwrapFormattedJsh strips the wrapper and one leading tab per body line', () => {
    // What Biome emits after formatting the wrapped body: the body is indented
    // one tab inside the async function.
    const formattedWrapped = 'async function __slicc() {\n\tconst x = 1;\n\treturn x;\n}\n';
    expect(unwrapFormattedJsh(formattedWrapped)).toBe('const x = 1;\nreturn x;\n');
  });

  it('round-trips a body through wrap → simulated tab-indent → unwrap', () => {
    const body = 'const value = await work();\nif (value) {\n\treturn value;\n}\n';
    // Simulate Biome indenting every non-empty body line by one tab.
    const indented = body
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => (line === '' ? '' : `\t${line}`))
      .join('\n');
    const formattedWrapped = `${JSH_WRAP_PREFIX}${indented}\n}\n`;
    expect(unwrapFormattedJsh(formattedWrapped)).toBe(body);
  });

  it('preserves deeper indentation (only one tab is removed)', () => {
    const formattedWrapped = 'async function __slicc() {\n\tif (a) {\n\t\tb();\n\t}\n}\n';
    expect(unwrapFormattedJsh(formattedWrapped)).toBe('if (a) {\n\tb();\n}\n');
  });
});
