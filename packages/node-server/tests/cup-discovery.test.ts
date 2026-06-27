/**
 * Coverage for the cup discovery file (`~/.slicc/cup.json`). This
 * file lets a *second* orchestrator session find an already-running cup
 * instance's port instead of accidentally launching a parallel one. It is a
 * hint only — liveness must still be confirmed by probing GET /api/status, so
 * the reader must collapse every failure (missing / corrupt / wrong-shape /
 * out-of-range) to null and never throw.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCupDiscovery,
  cupDiscoveryPath,
  readCupDiscovery,
  writeCupDiscovery,
} from '../src/cup-discovery.js';

describe('cup-discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-disc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a written record through read', () => {
    const rec = { port: 5710, pid: 4242, startedAt: '2026-06-25T10:00:00.000Z' };
    writeCupDiscovery(rec, dir);
    expect(readCupDiscovery(dir)).toEqual(rec);
  });

  it('writes the record to <dir>/cup.json as pretty JSON', () => {
    expect(cupDiscoveryPath(dir)).toBe(join(dir, 'cup.json'));
    const rec = { port: 5710, pid: 4242, startedAt: '2026-06-25T10:00:00.000Z' };
    writeCupDiscovery(rec, dir);
    const onDisk = JSON.parse(readFileSync(join(dir, 'cup.json'), 'utf-8'));
    expect(onDisk).toEqual(rec);
  });

  it.skipIf(process.platform === 'win32')('writes the file mode 0600 (owner-only)', () => {
    // The file advertises the cup RCE surface (its port). Other local
    // users must not be able to read it — mirror the 0600 of ~/.slicc/session-id.
    writeCupDiscovery({ port: 5710, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' }, dir);
    const mode = statSync(join(dir, 'cup.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'does', 'not', 'exist');
    const rec = { port: 5710, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' };
    writeCupDiscovery(rec, nested);
    expect(readCupDiscovery(nested)).toEqual(rec);
  });

  it('returns null when the file is missing', () => {
    expect(readCupDiscovery(dir)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(join(dir, 'cup.json'), 'not json {', 'utf-8');
    expect(readCupDiscovery(dir)).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    writeFileSync(
      join(dir, 'cup.json'),
      JSON.stringify({ port: 5710, startedAt: '2026-06-25T10:00:00.000Z' }),
      'utf-8'
    );
    expect(readCupDiscovery(dir)).toBeNull();
  });

  it('returns null when the port is out of range', () => {
    writeFileSync(
      join(dir, 'cup.json'),
      JSON.stringify({ port: 70000, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' }),
      'utf-8'
    );
    expect(readCupDiscovery(dir)).toBeNull();
  });

  it('clear removes the file and is a no-op when already absent', () => {
    writeCupDiscovery({ port: 5710, pid: 1, startedAt: '2026-06-25T10:00:00.000Z' }, dir);
    clearCupDiscovery(dir);
    expect(readCupDiscovery(dir)).toBeNull();
    // second clear must not throw
    expect(() => clearCupDiscovery(dir)).not.toThrow();
  });
});
