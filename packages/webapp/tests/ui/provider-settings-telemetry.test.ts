// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/kernel/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/telemetry.js')>(
    '../../src/kernel/telemetry.js'
  );
  return { ...actual, trackSettingsOpen: vi.fn() };
});

import { trackSettingsOpen } from '../../src/kernel/telemetry.js';

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
