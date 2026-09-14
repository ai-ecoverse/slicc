// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupSudoExtension, setupSudoStandalone } from '../../../src/ui/boot/setup-sudo.js';

const SUDO_BRIDGE_GLOBAL_KEY = '__slicc_sudo';

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[SUDO_BRIDGE_GLOBAL_KEY];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SUDO_BRIDGE_GLOBAL_KEY];
});

describe('setupSudoStandalone', () => {
  it('publishes the sudo bridge on globalThis.__slicc_sudo', async () => {
    expect((globalThis as Record<string, unknown>)[SUDO_BRIDGE_GLOBAL_KEY]).toBeUndefined();

    await setupSudoStandalone({ log: silentLog });

    const bridge = (globalThis as Record<string, unknown>)[SUDO_BRIDGE_GLOBAL_KEY] as
      | { requestApproval: unknown }
      | undefined;
    expect(bridge).toBeDefined();
    expect(typeof bridge?.requestApproval).toBe('function');
  });
});

describe('setupSudoExtension', () => {
  it('does not throw when chrome.runtime is unavailable', async () => {
    await expect(setupSudoExtension({ log: silentLog })).resolves.toBeUndefined();
  });
});
