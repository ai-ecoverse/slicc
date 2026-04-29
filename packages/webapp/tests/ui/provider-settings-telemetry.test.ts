// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackSettingsOpen: vi.fn() };
});

import { trackSettingsOpen } from '../../src/ui/telemetry.js';

describe('showProviderSettings — trackSettingsOpen wiring', () => {
  beforeEach(() => {
    vi.mocked(trackSettingsOpen).mockClear();
    document.body.replaceChildren();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('fires trackSettingsOpen("button") on dialog open', async () => {
    const { showProviderSettings } = await import('../../src/ui/provider-settings.js');
    void showProviderSettings();
    expect(trackSettingsOpen).toHaveBeenCalledWith('button');
  });
});
