import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findRawSniffs, PATTERN, stripComments } from './check-no-raw-chrome-runtime-id.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-no-raw-chrome-runtime-id.mjs');

/** Run the guard as the entry script. */
function runGuard() {
  try {
    return {
      code: 0,
      out: execFileSync('node', [scriptPath], { encoding: 'utf8' }),
    };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

describe('check-no-raw-chrome-runtime-id: PATTERN', () => {
  it('matches runtime.id and runtime?.id', () => {
    expect(PATTERN.test('chrome.runtime.id')).toBe(true);
    expect(PATTERN.test('chrome?.runtime?.id')).toBe(true);
    expect(PATTERN.test('chromeApi.runtime.id')).toBe(true);
  });

  it('does not match unrelated runtime properties', () => {
    expect(PATTERN.test('chrome.runtime.connect')).toBe(false);
    expect(PATTERN.test('chrome.runtime.sendMessage')).toBe(false);
    expect(PATTERN.test('runtime.identity')).toBe(false);
  });
});

describe('check-no-raw-chrome-runtime-id: stripComments', () => {
  it('strips line and block comments preserving line count', () => {
    const src = 'code\n// chrome.runtime.id check\n/* runtime?.id */\nmore';
    const stripped = stripComments(src);
    expect(stripped).not.toContain('runtime');
    expect(stripped.split('\n')).toHaveLength(4);
  });
});

describe('check-no-raw-chrome-runtime-id: findRawSniffs', () => {
  it('flags a raw runtime.id boolean check', () => {
    const hits = findRawSniffs('if (typeof chrome !== "undefined" && chrome?.runtime?.id) {');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it('ignores mentions in comments', () => {
    expect(findRawSniffs('// chrome.runtime.id is truthy here')).toEqual([]);
    expect(findRawSniffs('/* runtime?.id guard */ const x = 1;')).toEqual([]);
  });

  it('flags inline checks in various patterns', () => {
    expect(findRawSniffs('const isExt = !!chrome?.runtime?.id;')).toHaveLength(1);
    expect(findRawSniffs('return typeof c?.runtime?.id === "string";')).toHaveLength(1);
  });

  it('returns nothing for clean runtime-env usage', () => {
    expect(findRawSniffs('import { isExtensionRealm } from "./runtime-env.js";')).toEqual([]);
  });
});

describe('check-no-raw-chrome-runtime-id: end-to-end', () => {
  it('passes against the real webapp source tree', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no raw chrome\.runtime\.id sniffs in \d+ webapp source files/);
  });
});
