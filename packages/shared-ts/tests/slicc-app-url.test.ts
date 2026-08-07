import { describe, expect, it } from 'vitest';
import { isSliccAppUrl } from '../src/slicc-app-url.js';

const SELF = 'http://localhost:8787';

describe('isSliccAppUrl', () => {
  it('rejects any URL carrying a capability param, whatever the origin serves it', () => {
    // This is the security case: the float's own URL carries `bridgeToken`,
    // which authorizes driving its CDP bridge. Teleporting that tab would
    // copy the capability into another machine's browser and history.
    expect(isSliccAppUrl(`${SELF}/?bridge=ws%3A%2F%2Flocalhost%3A5715%2Fcdp&bridgeToken=abc`)).toBe(
      true
    );
    expect(isSliccAppUrl('https://example.test/?bridgeToken=abc')).toBe(true);
    expect(isSliccAppUrl('https://example.test/?tray=https%3A%2F%2Fhub%2Fjoin%2Ftok')).toBe(true);
    expect(isSliccAppUrl('https://host.example/embed?cherry=1')).toBe(true);
  });

  it('matches mode flags only at the value the app actually reads', () => {
    // `cherry` and `connect` are mode flags, not capabilities: the app tests
    // them for exactly '1'. Matching on mere presence hid ordinary pages —
    // an OAuth URL carrying `?connect=oauth2` is a tab the user may want to
    // move, and blocking it is a bug, not caution.
    expect(isSliccAppUrl('https://auth.example.com/authorize?connect=oauth2')).toBe(false);
    expect(isSliccAppUrl('https://shop.example/fruit?cherry=please')).toBe(false);
    expect(isSliccAppUrl('https://shop.example/fruit?cherry')).toBe(false);
    // The real flags still match.
    expect(isSliccAppUrl('https://host.example/embed?cherry=1&ui-only=1')).toBe(true);
    expect(isSliccAppUrl('https://host.example/x?connect=1')).toBe(true);
  });

  it('still rejects a capability param whatever its value', () => {
    // These carry the secret in the value, so any value is disqualifying.
    expect(isSliccAppUrl('https://example.test/?tray=anything')).toBe(true);
    expect(isSliccAppUrl('https://example.test/?bridgeToken=')).toBe(true);
  });

  it('recognizes the app shell on the hosted and staging origins', () => {
    expect(isSliccAppUrl('https://www.sliccy.ai/')).toBe(true);
    expect(isSliccAppUrl('https://www.sliccy.ai')).toBe(true);
    expect(isSliccAppUrl('https://www.sliccy.ai/index.html')).toBe(true);
    expect(isSliccAppUrl('https://www.sliccy.ai/join/abc.def')).toBe(true);
    expect(isSliccAppUrl('https://www.sliccy.ai/cloud')).toBe(true);
    expect(isSliccAppUrl('https://slicc-tray-hub-staging.minivelos.workers.dev/join/abc.def')).toBe(
      true
    );
  });

  it('recognizes the shell on a local wrangler passed as a self origin', () => {
    expect(isSliccAppUrl(`${SELF}/`, { selfOrigins: [SELF] })).toBe(true);
    // Without the hint, a bare localhost root is just some page.
    expect(isSliccAppUrl(`${SELF}/`)).toBe(false);
  });

  it('leaves ordinary pages on a SLICC origin alone', () => {
    // A docs page on sliccy.ai is a real page someone may want to move.
    expect(isSliccAppUrl('https://www.sliccy.ai/docs/architecture')).toBe(false);
    expect(isSliccAppUrl('https://www.sliccy.ai/privacy')).toBe(false);
  });

  it('leaves unrelated pages alone', () => {
    expect(isSliccAppUrl('https://www.adobe.com/')).toBe(false);
    expect(isSliccAppUrl('https://www.aem.live/docs')).toBe(false);
    expect(isSliccAppUrl('https://example.com/')).toBe(false);
  });

  it('treats unparseable input as not-an-app-url rather than throwing', () => {
    expect(isSliccAppUrl('about:blank')).toBe(false);
    expect(isSliccAppUrl('')).toBe(false);
    expect(isSliccAppUrl('not a url')).toBe(false);
  });
});
