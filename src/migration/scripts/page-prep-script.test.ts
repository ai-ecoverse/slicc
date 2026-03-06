// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PAGE_PREP_SCRIPT } from './page-prep-script.js';

// AsyncFunction constructor: validates that the script body is
// legal inside an async context (BrowserAPI.evaluate wraps in async).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

describe('PAGE_PREP_SCRIPT', () => {
  it('is valid JavaScript (new AsyncFunction does not throw)', () => {
    expect(() => new AsyncFunction(PAGE_PREP_SCRIPT)).not.toThrow();
  });

  it('converts fixed-position elements to relative', async () => {
    const fixedDiv = document.createElement('div');
    fixedDiv.style.position = 'fixed';
    document.body.appendChild(fixedDiv);

    const stickyDiv = document.createElement('div');
    stickyDiv.style.position = 'static';
    document.body.appendChild(stickyDiv);

    const fn = new Function(`return (async () => { ${PAGE_PREP_SCRIPT} })()`);
    await fn();

    expect(fixedDiv.style.position).toBe('relative');
    expect(stickyDiv.style.position).toBe('static');

    fixedDiv.remove();
    stickyDiv.remove();
  });

  it('returns JSON with expected stats structure', async () => {
    const fn = new Function(`return (async () => { ${PAGE_PREP_SCRIPT} })()`);
    const result = await fn();

    expect(result).toEqual(
      expect.objectContaining({
        fixedElementsConverted: expect.any(Number),
        totalHeight: expect.any(Number),
        stepsScrolled: expect.any(Number),
      }),
    );
  });
});
