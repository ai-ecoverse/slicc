import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest side panel', () => {
  it('declares the sidePanel permission', () => {
    expect(manifest.permissions).toContain('sidePanel');
  });
  it('registers the default side panel path', () => {
    expect((manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path).toBe(
      'sidepanel.html'
    );
  });
  it('sets a minimum_chrome_version >= 116 (sidePanel.open availability)', () => {
    const v = Number((manifest as { minimum_chrome_version?: string }).minimum_chrome_version);
    expect(v).toBeGreaterThanOrEqual(116);
  });
});
