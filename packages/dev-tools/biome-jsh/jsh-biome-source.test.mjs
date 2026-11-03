import { describe, expect, it } from 'vitest';
import {
  biomeVirtualPath,
  isLintableFile,
  JSH_WRAP_PREFIX,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  JSH_WRAP_PREFIX_LINE_COUNT,
  JSH_WRAP_SUFFIX,
  shouldWrapForBiome,
  splitJshShebang,
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

describe('leading shebang (issue #4200)', () => {
  const SHEBANG = '#!/usr/bin/env jsh\n';
  const body = 'const a = await Promise.resolve(1);\nconsole.log(a);\n';

  it('splitJshShebang splits off only a first-line shebang', () => {
    expect(splitJshShebang(SHEBANG + body)).toEqual({ header: SHEBANG, body });
    expect(splitJshShebang(body)).toEqual({ header: '', body });
    // A `#!` anywhere but the very first line is left in the body.
    expect(splitJshShebang(`\n${SHEBANG}${body}`)).toEqual({
      header: '',
      body: `\n${SHEBANG}${body}`,
    });
  });

  it('splitJshShebang keeps the blank lines right after the shebang in the header', () => {
    expect(splitJshShebang(`${SHEBANG}\n \nx();\n`)).toEqual({
      header: `${SHEBANG}\n \n`,
      body: 'x();\n',
    });
  });

  it('splitJshShebang newline-terminates a shebang-only file', () => {
    expect(splitJshShebang('#!/usr/bin/env jsh')).toEqual({ header: SHEBANG, body: '' });
  });

  it('wrapJshForBiome hoists the shebang above the wrapper', () => {
    expect(wrapJshForBiome(SHEBANG + body)).toBe(
      SHEBANG + JSH_WRAP_PREFIX + body + JSH_WRAP_SUFFIX
    );
  });

  it('every body line still shifts by exactly one line and the prefix byte length', () => {
    // Shebang + one blank line form the hoisted header (real lines 1-2).
    const source = `${SHEBANG}\n${body}`;
    const headerLines = 2;
    const wrapped = wrapJshForBiome(source);
    const realLines = source.split('\n');
    const wrappedLines = wrapped.split('\n');
    // The header lines stay where they are, above the wrapper.
    expect(wrappedLines.slice(0, headerLines)).toEqual(realLines.slice(0, headerLines));
    expect(wrappedLines[headerLines]).toBe(JSH_WRAP_PREFIX.slice(0, -1));
    for (let i = headerLines; i < realLines.length - 1; i++) {
      expect(wrappedLines[i + JSH_WRAP_PREFIX_LINE_COUNT]).toBe(realLines[i]);
    }
    const offset = source.indexOf('console');
    expect(wrapped.indexOf('console')).toBe(offset + JSH_WRAP_PREFIX_BYTE_LENGTH);
  });

  it('unwrapFormattedJsh puts the shebang (and a blank line after it) back', () => {
    expect(unwrapFormattedJsh(`${SHEBANG}async function __slicc() {\n\tx();\n}\n`)).toBe(
      `${SHEBANG}x();\n`
    );
    expect(unwrapFormattedJsh(`${SHEBANG}\nasync function __slicc() {\n\tx();\n}\n`)).toBe(
      `${SHEBANG}\nx();\n`
    );
    expect(unwrapFormattedJsh(`${SHEBANG}async function __slicc() {}\n`)).toBe(SHEBANG);
  });

  it('round-trips wrap → simulated tab-indent → unwrap with a shebang', () => {
    const source = `${SHEBANG}${body}`;
    const indented = body
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => `\t${line}`)
      .join('\n');
    expect(unwrapFormattedJsh(`${SHEBANG}${JSH_WRAP_PREFIX}${indented}\n}\n`)).toBe(source);
  });
});
