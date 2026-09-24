import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SYNC_EXEC_CHANNEL,
  SYNC_EXEC_MAX_TIMEOUT_MS,
  SYNC_FS_ROUTE_PREFIX,
} from '../../../src/kernel/realm/sync-fs-wire.js';

const WIRE_SRC = fileURLToPath(
  new URL('../../../src/kernel/realm/sync-fs-wire.ts', import.meta.url)
);

/**
 * The wire module advertises itself as the dependency-free leaf of the sync
 * subsystem — every side imports it, so it must import nothing back from its
 * own consumers (the dispatch modules + token registry), else the fan-in
 * inverts into a cycle cluster no lint here can see (kernel/ is unranked). This
 * guard fails closed if a relative import ever creeps back in.
 */
describe('sync-fs-wire — dependency-free leaf', () => {
  it('imports nothing from sibling realm modules (no back-edges)', () => {
    const src = readFileSync(WIRE_SRC, 'utf8');
    const relativeImports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"](\.[^'"]+)['"]/gm)].map(
      (m) => m[1]
    );
    expect(relativeImports).toEqual([]);
  });

  it('owns the wire-payload contract it composes from', () => {
    // The `SyncFsReqMsg` union is composed here from `SyncFsRequest` /
    // `SyncExecRequest`, so those types must be defined in this module, not
    // re-imported from a consumer.
    const src = readFileSync(WIRE_SRC, 'utf8');
    expect(src).toMatch(/export interface SyncFsRequest\b/);
    expect(src).toMatch(/export interface SyncExecRequest\b/);
    expect(src).toMatch(/export type SyncFsResult\b/);
    expect(src).toMatch(/export const SYNC_EXEC_CHANNEL\b/);
    // Runtime constants stay live and importable.
    expect(SYNC_EXEC_CHANNEL).toBe('exec');
    expect(SYNC_EXEC_MAX_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SYNC_FS_ROUTE_PREFIX).toBe('/__slicc/fs-sync/');
  });
});
