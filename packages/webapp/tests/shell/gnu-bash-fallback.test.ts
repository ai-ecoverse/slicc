import { describe, expect, it, vi } from 'vitest';
import { SHELL_CHOICE_ENV } from '../../src/shell/gnu-bash.js';
import { GnuBashFallback } from '../../src/shell/gnu-bash-fallback.js';
import type { ScriptCatalog } from '../../src/shell/script-catalog.js';

function fallback(overrides: {
  gnuBash?: boolean;
  lastEnv?: Record<string, string>;
  wasmHasBash?: boolean;
}): GnuBashFallback {
  return new GnuBashFallback({
    gnuBash: overrides.gnuBash ?? true,
    lastEnv: overrides.lastEnv ?? {},
    cwd: '/',
    umask: 0o022,
    vfsAdapter: {} as never,
    bash: {} as never,
    scriptCatalog: {
      getWasmCommands: vi.fn(async () =>
        overrides.wasmHasBash === false ? new Map() : new Map([['bash', {}]])
      ),
    } as unknown as ScriptCatalog,
    outputTees: new Map(),
    gateNativeCommand: async () => null,
    buildJshProcessConfig: () => undefined,
    gitIdentity: async () => ({ name: 'User', email: 'user@example.com' }),
    flushPendingCommandGrants: async () => undefined,
    applyPendingEnvWrites: () => undefined,
    syncJshCommands: async () => undefined,
    adoptCwd: () => undefined,
    adoptEnv: () => undefined,
  });
}

describe('GnuBashFallback.usesGnuBash', () => {
  it('is false when the shell did not ask for GNU bash', async () => {
    expect(await fallback({ gnuBash: false }).usesGnuBash()).toBe(false);
  });

  it('is false when SLICC_SHELL=just-bash', async () => {
    expect(await fallback({ lastEnv: { [SHELL_CHOICE_ENV]: 'just-bash' } }).usesGnuBash()).toBe(
      false
    );
  });

  it('is false when no wasm bash is installed', async () => {
    expect(await fallback({ wasmHasBash: false }).usesGnuBash()).toBe(false);
  });

  it('is true when asked for, not opted out, and wasm bash is present', async () => {
    if (typeof SharedArrayBuffer !== 'function') return;
    expect(await fallback({}).usesGnuBash()).toBe(true);
  });
});
