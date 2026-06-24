/**
 * Coverage for the substrate discovery file (`~/.slicc/substrate.json`). This
 * file lets a *second* orchestrator session find an already-running substrate
 * instance's port instead of accidentally launching a parallel one. It is a
 * hint only — liveness must still be confirmed by probing GET /api/status, so
 * the reader must collapse every failure (missing / corrupt / wrong-shape /
 * out-of-range) to null and never throw.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSubstrateDiscovery,
  readSubstrateDiscovery,
  substrateDiscoveryPath,
  writeSubstrateDiscovery,
} from '../src/substrate-discovery.js';

describe('substrate-discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-disc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a written record through read', () => {
    const rec = { port: 5710, pid: 4242, startedAt: '2026-06-25T10:00:00.000Z' };
    writeSubstrateDiscovery(rec, dir);
    expect(readSubstrateDiscovery(dir)).toEqual(rec);
  });

  it('writes the record to <dir>/substrate.json as pretty JSON', () => {
    expect(substrateDiscoveryPath(dir)).toBe(join(dir, 'substrate.json'));
    const rec = { port: 5710, pid: 4242, startedAt: '2026-06-25T10:00:00.000Z' };
    writeSubstrateDiscovery(rec, dir);
    const onDisk = JSON.parse(readFileSync(join(dir, 'substrate.json'), 'utf-8'));
    expect(onDisk).toEqual(rec);
  });

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'does', 'not', 'exist');
    const rec = { port: 5710, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' };
    writeSubstrateDiscovery(rec, nested);
    expect(readSubstrateDiscovery(nested)).toEqual(rec);
  });

  it('returns null when the file is missing', () => {
    expect(readSubstrateDiscovery(dir)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(join(dir, 'substrate.json'), 'not json {', 'utf-8');
    expect(readSubstrateDiscovery(dir)).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    writeFileSync(
      join(dir, 'substrate.json'),
      JSON.stringify({ port: 5710, startedAt: '2026-06-25T10:00:00.000Z' }),
      'utf-8'
    );
    expect(readSubstrateDiscovery(dir)).toBeNull();
  });

  it('returns null when the port is out of range', () => {
    writeFileSync(
      join(dir, 'substrate.json'),
      JSON.stringify({ port: 70000, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' }),
      'utf-8'
    );
    expect(readSubstrateDiscovery(dir)).toBeNull();
  });

  it('clear removes the file and is a no-op when already absent', () => {
    writeSubstrateDiscovery({ port: 5710, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' }, dir);
    clearSubstrateDiscovery(dir);
    expect(readSubstrateDiscovery(dir)).toBeNull();
    // second clear must not throw
    expect(() => clearSubstrateDiscovery(dir)).not.toThrow();
  });
});
