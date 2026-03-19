import { describe, expect, it } from 'vitest';

import {
  buildServerRuntimeSpawnConfig,
  DEFAULT_SERVER_RUNTIME,
  parseServerRuntimePreference,
  resolveServerRuntimeSelection,
  resolveSwiftServerBinaryPath,
  SERVER_RUNTIME_ENV,
  SWIFT_SERVER_PATH_ENV,
} from './server-runtime.js';

describe('server-runtime', () => {
  it('defaults unknown runtime preferences to node', () => {
    expect(parseServerRuntimePreference(undefined)).toBe(DEFAULT_SERVER_RUNTIME);
    expect(parseServerRuntimePreference('nope')).toBe(DEFAULT_SERVER_RUNTIME);
  });

  it('resolves a configured swift binary path relative to the project root', () => {
    expect(resolveSwiftServerBinaryPath('/repo', { [SWIFT_SERVER_PATH_ENV]: 'native/SliccServer' })).toBe(
      '/repo/native/SliccServer',
    );
  });

  it('selects swift when requested and configured', () => {
    expect(
      resolveServerRuntimeSelection({
        projectRoot: '/repo',
        dev: false,
        cdpPort: 9555,
        preferredRuntime: 'swift',
        swiftBinaryPath: 'native/SliccServer',
      }),
    ).toEqual({
      requestedRuntime: 'swift',
      selectedRuntime: 'swift',
      fallbackReason: null,
      swiftBinaryPath: '/repo/native/SliccServer',
    });
  });

  it('falls back to node when swift is requested in dev mode', () => {
    expect(
      resolveServerRuntimeSelection({
        projectRoot: '/repo',
        dev: true,
        cdpPort: 9555,
        preferredRuntime: 'swift',
        swiftBinaryPath: 'native/SliccServer',
      }),
    ).toEqual({
      requestedRuntime: 'swift',
      selectedRuntime: 'node',
      fallbackReason: 'Swift runtime is not wired into the Vite dev flow yet.',
      swiftBinaryPath: '/repo/native/SliccServer',
    });
  });

  it('falls back to node when swift is requested without a configured binary', () => {
    expect(
      resolveServerRuntimeSelection({
        projectRoot: '/repo',
        dev: false,
        cdpPort: 9555,
        env: { [SERVER_RUNTIME_ENV]: 'swift' },
      }),
    ).toEqual({
      requestedRuntime: 'swift',
      selectedRuntime: 'node',
      fallbackReason: `Swift runtime requested but ${SWIFT_SERVER_PATH_ENV} is not configured.`,
      swiftBinaryPath: null,
    });
  });

  it('builds a swift spawn contract when selected', () => {
    expect(
      buildServerRuntimeSpawnConfig({
        projectRoot: '/repo',
        dev: false,
        cdpPort: 9555,
        preferredRuntime: 'swift',
        swiftBinaryPath: 'native/SliccServer',
      }),
    ).toEqual({
      requestedRuntime: 'swift',
      selectedRuntime: 'swift',
      fallbackReason: null,
      swiftBinaryPath: '/repo/native/SliccServer',
      command: '/repo/native/SliccServer',
      args: ['--serve-only', '--cdp-port=9555'],
    });
  });
});