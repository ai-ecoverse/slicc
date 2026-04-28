/**
 * Tests for the Adobe session identifier.
 *
 * Verifies the privacy properties called out in the reviewer feedback on
 * PR #378: random UUID (no timestamp correlation), daily rotation, hashed
 * scoop folder (no name leak), and relationship preservation between a cone
 * and its scoops.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAdobeSessionId,
  __resetAdobeSessionIdCacheForTests,
} from '../../src/scoops/llm-session-id.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const baseScoop: Omit<RegisteredScoop, 'jid' | 'folder' | 'name' | 'isCone' | 'type'> = {
  requiresTrigger: false,
  assistantLabel: 'x',
  addedAt: '2026-04-23T00:00:00.000Z',
};

function cone(jid: string): RegisteredScoop {
  return { ...baseScoop, jid, folder: 'cone', name: 'sliccy', isCone: true, type: 'cone' };
}

function scoop(folder: string, jid = `scoop_${folder}_1`): RegisteredScoop {
  return { ...baseScoop, jid, folder, name: folder, isCone: false, type: 'scoop' };
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('getAdobeSessionId', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    __resetAdobeSessionIdCacheForTests();
  });

  it('returns a UUID (not a timestamp-derived string) for the cone', async () => {
    const id = await getAdobeSessionId(cone('cone_17126000'), 'cone_17126000');
    // RFC 4122 UUID v4
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toContain('17126000');
  });

  it('is stable within the same calendar day for the same cone', async () => {
    const jid = 'cone_17126000';
    const a = await getAdobeSessionId(cone(jid), jid);
    const b = await getAdobeSessionId(cone(jid), jid);
    expect(a).toBe(b);
  });

  it('rotates when the stored entry is from a different day', async () => {
    const jid = 'cone_17126000';
    const staleKey = `slicc:adobe-daily-uuid:${jid}`;
    storage.setItem(staleKey, JSON.stringify({ uuid: 'yesterday-uuid', date: '1999-01-01' }));

    const id = await getAdobeSessionId(cone(jid), jid);
    expect(id).not.toBe('yesterday-uuid');
    // The new value was written back.
    const persisted = JSON.parse(storage.getItem(staleKey) ?? '{}');
    expect(persisted.uuid).toBe(id);
    expect(persisted.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('produces different UUIDs for different cones', async () => {
    const a = await getAdobeSessionId(cone('cone_a'), 'cone_a');
    const b = await getAdobeSessionId(cone('cone_b'), 'cone_b');
    expect(a).not.toBe(b);
  });

  it('formats scoop IDs as <coneUuid>/<hash> and hides the folder name', async () => {
    const coneJid = 'cone_42';
    const coneId = await getAdobeSessionId(cone(coneJid), coneJid);
    const id = await getAdobeSessionId(scoop('my-secret-project'), coneJid);

    const [prefix, suffix] = id.split('/');
    expect(prefix).toBe(coneId);
    expect(suffix).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('my-secret-project');
  });

  it('salts the folder hash with the daily UUID (different cones → different suffix)', async () => {
    const a = await getAdobeSessionId(scoop('shared-folder'), 'cone_a');
    const b = await getAdobeSessionId(scoop('shared-folder'), 'cone_b');
    const [, suffixA] = a.split('/');
    const [, suffixB] = b.split('/');
    expect(suffixA).not.toBe(suffixB);
  });

  it('falls back to the scoop JID as anchor when no coneJid is provided', async () => {
    const s = scoop('orphan', 'scoop_orphan_1');
    const id = await getAdobeSessionId(s, undefined);
    const [prefix, suffix] = id.split('/');
    expect(prefix).toMatch(/^[0-9a-f]{8}-/); // a UUID
    expect(suffix).toMatch(/^[0-9a-f]{16}$/);
  });

  it('falls back when global localStorage is not a usable Storage object', async () => {
    vi.stubGlobal('localStorage', {});

    const id = await getAdobeSessionId(cone('cone_invalid_storage'), 'cone_invalid_storage');

    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });
});
