import { describe, expect, it } from 'vitest';
import { isWcUiEnabled } from '../../../src/ui/wc/wc-flag.js';

describe('isWcUiEnabled', () => {
  it('is off for a plain app URL', () => {
    expect(isWcUiEnabled('http://localhost:5710/')).toBe(false);
  });

  it('turns on with ?ui=wc', () => {
    expect(isWcUiEnabled('http://localhost:5710/?ui=wc')).toBe(true);
  });

  it('ignores other ui values', () => {
    expect(isWcUiEnabled('http://localhost:5710/?ui=legacy')).toBe(false);
    expect(isWcUiEnabled('http://localhost:5710/?ui=')).toBe(false);
  });

  it('composes with other query params', () => {
    expect(isWcUiEnabled('http://localhost:5710/?ui-fixture=1&ui=wc')).toBe(true);
    expect(isWcUiEnabled('http://localhost:5710/?kernel-worker=1&ui=wc&x=1')).toBe(true);
  });

  it('is off for unparseable hrefs', () => {
    expect(isWcUiEnabled('not a url')).toBe(false);
    expect(isWcUiEnabled('')).toBe(false);
  });
});
