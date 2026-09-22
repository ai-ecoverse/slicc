// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  showCdpBridgeRejectedBanner,
  showCdpSupersededBanner,
} from '../../src/ui/cdp-superseded-banner.js';

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

describe('showCdpBridgeRejectedBanner', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('tells the user to reopen from Sliccstart', () => {
    showCdpBridgeRejectedBanner(document);
    const el = document.getElementById('slicc-cdp-bridge-rejected-banner');
    expect(el?.getAttribute('role')).toBe('alert');
    expect(el?.textContent).toMatch(/bridge token/i);
    expect(el?.textContent).toMatch(/Sliccstart/);
  });

  it('is idempotent', () => {
    showCdpBridgeRejectedBanner(document);
    showCdpBridgeRejectedBanner(document);
    expect(document.querySelectorAll('#slicc-cdp-bridge-rejected-banner')).toHaveLength(1);
  });
});
