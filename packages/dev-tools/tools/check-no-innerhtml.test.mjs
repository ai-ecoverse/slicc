import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findInnerHtmlWrites, isShippedSource, stripComments } from './check-no-innerhtml.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'packages/dev-tools/tools/check-no-innerhtml.mjs');

/** Run the guard as the entry script, capturing output even on non-zero exit. */
function runGuard() {
  try {
    return { code: 0, out: execFileSync('node', [scriptPath], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('check-no-innerhtml: isShippedSource', () => {
  it('accepts component source .ts', () => {
    expect(isShippedSource('slicc-pill.ts')).toBe(true);
  });

  it('rejects stories and tests', () => {
    expect(isShippedSource('slicc-pill.stories.ts')).toBe(false);
    expect(isShippedSource('slicc-pill.test.ts')).toBe(false);
  });

  it('rejects non-.ts files', () => {
    expect(isShippedSource('tokens.css')).toBe(false);
    expect(isShippedSource('README.md')).toBe(false);
  });
});

describe('check-no-innerhtml: stripComments', () => {
  it('blanks // line comments and /* */ block comments but keeps line count', () => {
    const src = 'a\n// el.innerHTML = x\n/* y.innerHTML = z */\nb';
    const stripped = stripComments(src);
    expect(stripped).not.toContain('innerHTML');
    expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
  });
});

describe('check-no-innerhtml: findInnerHtmlWrites', () => {
  it('flags a real .innerHTML assignment with its line number', () => {
    const hits = findInnerHtmlWrites('const a = 1;\nel.innerHTML = "<b>x</b>";');
    expect(hits).toEqual([{ line: 2, label: '.innerHTML assignment' }]);
  });

  it('flags .outerHTML assignments and insertAdjacentHTML() calls', () => {
    expect(findInnerHtmlWrites('node.outerHTML = markup;')).toEqual([
      { line: 1, label: '.outerHTML assignment' },
    ]);
    expect(findInnerHtmlWrites('host.insertAdjacentHTML("beforeend", s);')).toEqual([
      { line: 1, label: 'insertAdjacentHTML() call' },
    ]);
  });

  it('ignores read comparisons (=== / ==)', () => {
    expect(findInnerHtmlWrites('if (el.innerHTML === "") return;')).toEqual([]);
    expect(findInnerHtmlWrites('while (el.innerHTML == "") {}')).toEqual([]);
  });

  it('ignores innerHTML mentioned only in a comment', () => {
    expect(findInnerHtmlWrites('// never set el.innerHTML = here')).toEqual([]);
    expect(findInnerHtmlWrites('/* el.innerHTML = legacy */\nconst x = 1;')).toEqual([]);
  });

  it('returns nothing for innerHTML-free DOM construction', () => {
    expect(findInnerHtmlWrites('root.replaceChildren(h("div", null, "x"));')).toEqual([]);
  });
});

describe('check-no-innerhtml: end-to-end over the real tree', () => {
  it('passes (the webcomponents source is innerHTML-free) and reports the count', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toMatch(/ok: no innerHTML writes in \d+ @slicc\/webcomponents source files/);
  });
});
