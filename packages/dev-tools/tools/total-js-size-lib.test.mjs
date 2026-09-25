import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTotalJsDelta, measureTotalJs } from './total-js-size-lib.mjs';

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('measureTotalJs', () => {
  it('counts top-level, eager and lazy JS once, excluding maps and other assets', () => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-total-js-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'slicc-diff.js'), '123');
    writeFileSync(join(dir, 'assets', 'index.js'), '12345');
    writeFileSync(join(dir, 'assets', 'lazy.js'), '1234567');
    writeFileSync(join(dir, 'assets', 'lazy.js.map'), '123456789');
    writeFileSync(join(dir, 'assets', 'theme.css'), '123456789');
    expect(measureTotalJs(dir)).toEqual({ bytes: 15, files: 3 });
  });

  it('rejects a missing build instead of passing a zero-byte bundle', () => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-total-js-'));
    expect(() => measureTotalJs(dir)).toThrow(/no JS files/);
  });
});

describe('checkTotalJsDelta', () => {
  const baseline = { bytes: 25_700_000 };

  it('allows an unchanged or routine change, including at the boundary', () => {
    expect(checkTotalJsDelta(baseline, baseline, 128)).toEqual({ deltaKb: 0, passed: true });
    expect(checkTotalJsDelta({ bytes: baseline.bytes + 128 * 1024 }, baseline, 128)).toEqual({
      deltaKb: 128,
      passed: true,
    });
  });

  it('rejects a large lazy dependency or duplicate chunk', () => {
    expect(
      checkTotalJsDelta({ bytes: baseline.bytes + 128 * 1024 + 1 }, baseline, 128).passed
    ).toBe(false);
  });

  it('leaves the absolute size-limit cap in force when the baseline is unavailable', () => {
    expect(checkTotalJsDelta(baseline, null, 128)).toEqual({ deltaKb: null, passed: true });
  });

  it('rejects a missing or invalid budget', () => {
    expect(() => checkTotalJsDelta(baseline, baseline, undefined)).toThrow(/maxDeltaKb/);
    expect(() => checkTotalJsDelta(baseline, baseline, -1)).toThrow(/maxDeltaKb/);
  });
});
