import { describe, expect, it } from 'vitest';
import { buildPrivacyResponse, CANONICAL_PRIVACY_URL } from '../src/privacy.js';

describe('privacy policy route', () => {
  it('redirects to the canonical policy instead of the SPA shell', async () => {
    const res = buildPrivacyResponse(new Request('https://www.sliccy.ai/privacy'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(CANONICAL_PRIVACY_URL);
    expect(res.headers.get('location')).toBe('https://www.sliccy.com/privacy');
    expect(await res.text()).toBe('');
  });

  it('handles HEAD the same way', () => {
    const res = buildPrivacyResponse(
      new Request('https://www.sliccy.ai/privacy', { method: 'HEAD' })
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(CANONICAL_PRIVACY_URL);
  });
});
