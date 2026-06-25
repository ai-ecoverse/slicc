import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findUiImports,
  isProviderSource,
  stripComments,
} from './check-no-ui-imports-in-providers.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(
  repoRoot,
  'packages/dev-tools/tools/check-no-ui-imports-in-providers.mjs'
);

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-no-ui-imports-in-providers: isProviderSource', () => {
  it('accepts provider source .ts', () => {
    expect(isProviderSource('azure-openai.ts')).toBe(true);
  });

  it('rejects tests and non-.ts files', () => {
    expect(isProviderSource('azure-openai.test.ts')).toBe(false);
    expect(isProviderSource('README.md')).toBe(false);
    expect(isProviderSource('types.json')).toBe(false);
  });
});

describe('check-no-ui-imports-in-providers: stripComments', () => {
  it('blanks // line comments and /* */ block comments but keeps line count', () => {
    const src = "a\n// import x from '../ui/y.js'\n/* '../../ui/z.js' */\nb";
    const stripped = stripComments(src);
    expect(stripped).not.toContain('ui/');
    expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
  });
});

describe('check-no-ui-imports-in-providers: findUiImports', () => {
  it('flags a one-level-up ui import with its line number', () => {
    const hits = findUiImports("import { x } from '../ui/foo.js';");
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].match).toContain("'../ui/foo.js'");
  });

  it('flags a two-level-up ui import (the historical azure-openai case)', () => {
    const hits = findUiImports(
      "import { getApiVersionForProvider } from '../../ui/provider-settings.js';"
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toContain("'../../ui/provider-settings.js'");
  });

  it('flags double-quoted imports too', () => {
    const hits = findUiImports('import x from "../ui/y.js";');
    expect(hits).toHaveLength(1);
  });

  it('flags re-export from a ui module', () => {
    const hits = findUiImports("export * from '../ui/foo.js';");
    expect(hits).toHaveLength(1);
  });

  it('ignores imports from sibling providers/ modules', () => {
    expect(findUiImports("import { x } from '../account-store.js';")).toEqual([]);
    expect(findUiImports("import { y } from '../types.js';")).toEqual([]);
  });

  it('ignores imports from unrelated paths that happen to contain "ui"', () => {
    expect(findUiImports("import { build } from '@earendil-works/pi-ai/dist/x.js';")).toEqual([]);
    expect(findUiImports("import x from '../guidance/foo.js';")).toEqual([]);
  });

  it('ignores ui mentioned only in a comment', () => {
    expect(findUiImports("// don't import from '../ui/whatever.js'")).toEqual([]);
    expect(findUiImports("/* historical: from '../../ui/provider-settings.js' */")).toEqual([]);
  });

  it('flags a string-literal dynamic import of a ui module', () => {
    const hits = findUiImports("const m = await import('../ui/foo.js');");
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toContain("'../ui/foo.js'");
  });

  it('flags a require() of a ui module', () => {
    const hits = findUiImports("const m = require('../../ui/provider-settings.js');");
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toContain("'../../ui/provider-settings.js'");
  });

  it('does not flag an identifier-suffixed dynamic import (no path literal)', () => {
    expect(findUiImports('const m = await import(uiSpec);')).toEqual([]);
  });
});

describe('check-no-ui-imports-in-providers: end-to-end over the real tree', () => {
  it('passes (providers/built-in is ui/-import-free) and reports the count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(
      /ok: no ui\/ imports in \d+ packages\/webapp\/src\/providers\/built-in\/ source files/
    );
  });
});
