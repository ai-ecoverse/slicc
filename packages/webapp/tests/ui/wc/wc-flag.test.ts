import { describe, expect, it } from 'vitest';
import { resolveWcUiMode } from '../../../src/ui/wc/wc-flag.js';

describe('resolveWcUiMode', () => {
  it('is off for a plain app URL', () => {
    expect(resolveWcUiMode('http://localhost:5710/')).toBe('off');
  });

  it('resolves live mode with ?ui=wc', () => {
    expect(resolveWcUiMode('http://localhost:5710/?ui=wc')).toBe('live');
  });

  it('resolves fixture mode with ?ui=wc&ui-fixture', () => {
    expect(resolveWcUiMode('http://localhost:5710/?ui=wc&ui-fixture')).toBe('fixture');
    expect(resolveWcUiMode('http://localhost:5710/?ui-fixture=1&ui=wc')).toBe('fixture');
  });

  it('ignores other ui values', () => {
    expect(resolveWcUiMode('http://localhost:5710/?ui=legacy')).toBe('off');
    expect(resolveWcUiMode('http://localhost:5710/?ui=')).toBe('off');
    expect(resolveWcUiMode('http://localhost:5710/?ui-fixture=1')).toBe('off');
  });

  it('composes with other query params', () => {
    expect(resolveWcUiMode('http://localhost:5710/?kernel-worker=1&ui=wc&x=1')).toBe('live');
  });

  it('is off for unparseable hrefs', () => {
    expect(resolveWcUiMode('not a url')).toBe('off');
    expect(resolveWcUiMode('')).toBe('off');
  });
});
