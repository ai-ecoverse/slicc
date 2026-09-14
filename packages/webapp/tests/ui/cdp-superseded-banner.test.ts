// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { showCdpSupersededBanner } from '../../src/ui/cdp-superseded-banner.js';

describe('showCdpSupersededBanner', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('injects a single alert banner with recovery guidance', () => {
    showCdpSupersededBanner(document);
    const el = document.getElementById('slicc-cdp-superseded-banner');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.textContent).toMatch(/taken control/i);
    expect(el?.textContent).toMatch(/reload/i);
  });

  it('is idempotent — a second call does not add a duplicate', () => {
    showCdpSupersededBanner(document);
    showCdpSupersededBanner(document);
    expect(document.querySelectorAll('#slicc-cdp-superseded-banner')).toHaveLength(1);
  });
});
