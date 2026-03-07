// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { OVERLAY_DISMISS_SCRIPT } from './overlay-dismiss-script.js';

describe('OVERLAY_DISMISS_SCRIPT', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(OVERLAY_DISMISS_SCRIPT)).not.toThrow();
  });

  it('returns JSON with dismissed count when no overlays', async () => {
    const fn = new Function(`return ${OVERLAY_DISMISS_SCRIPT}`);
    const raw = await fn();
    const result = JSON.parse(raw);
    expect(result).toHaveProperty('dismissed', 0);
    expect(result).toHaveProperty('results');
    expect(result.results).toEqual([]);
  });

  it('clicks OneTrust accept button when present', async () => {
    let clicked = false;
    const banner = document.createElement('div');
    banner.id = 'onetrust-consent-sdk';
    document.body.appendChild(banner);

    const btn = document.createElement('button');
    btn.id = 'onetrust-accept-btn-handler';
    btn.addEventListener('click', () => { clicked = true; });
    document.body.appendChild(btn);

    const fn = new Function(`return ${OVERLAY_DISMISS_SCRIPT}`);
    const raw = await fn();
    const result = JSON.parse(raw);

    expect(clicked).toBe(true);
    expect(result.dismissed).toBeGreaterThanOrEqual(1);
    expect(result.results[0].vendor).toBe('onetrust');
    expect(result.results[0].action).toBe('click');

    banner.remove();
    btn.remove();
  });

  it('removes banner when no dismiss button found', async () => {
    const banner = document.createElement('div');
    banner.id = 'CybotCookiebotDialog';
    document.body.appendChild(banner);

    const fn = new Function(`return ${OVERLAY_DISMISS_SCRIPT}`);
    const raw = await fn();
    const result = JSON.parse(raw);

    expect(document.getElementById('CybotCookiebotDialog')).toBeNull();
    expect(result.dismissed).toBeGreaterThanOrEqual(1);
    expect(result.results.some(
      (r: { action: string }) => r.action === 'remove'
    )).toBe(true);
  });
});
