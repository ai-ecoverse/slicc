import type { WorkerEnv } from '../../src/index.js';

/**
 * Creates a fake WorkerEnv for testing with sensible defaults.
 * Pass overrides to customize specific bindings.
 */
export function makeEnv(overrides?: Partial<WorkerEnv>): WorkerEnv {
  const fakeAssets = {
    fetch: async () => new Response('fake'),
  };

  const fakeR2 = {
    get: async () => null,
  };

  const fakeTrayHub = {
    idFromName: (_name: string) => ({ toString: () => 'fake-tray-id' }),
    idFromString: (_id: string) => ({ toString: () => 'fake-tray-id' }),
    newUniqueId: () => ({ toString: () => 'fake-tray-id' }),
    get: (_id: unknown) => ({
      fetch: async (_req: Request) => new Response('tray DO not stubbed', { status: 501 }),
    }),
  };

  const fakeCloudSessions = {
    idFromName: (_name: string) => ({ toString: () => 'fake-cloud-id' }),
    idFromString: (_id: string) => ({ toString: () => 'fake-cloud-id' }),
    newUniqueId: () => ({ toString: () => 'fake-cloud-id' }),
    get: (_id: unknown) => ({
      fetch: async (_req: Request) => new Response('cloud DO not stubbed', { status: 501 }),
    }),
  };

  return {
    TRAY_HUB: fakeTrayHub as unknown as WorkerEnv['TRAY_HUB'],
    CLOUD_SESSIONS: fakeCloudSessions as unknown as WorkerEnv['CLOUD_SESSIONS'],
    ASSETS: fakeAssets,
    ASSET_ARCHIVE: fakeR2,
    ...overrides,
  } as unknown as WorkerEnv;
}
