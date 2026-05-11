import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readOrCreateSwSessionId } from '../src/sw-session-id.js';

describe('readOrCreateSwSessionId', () => {
  let storage: Record<string, string>;
  beforeEach(() => {
    storage = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in storage ? { [key]: storage[key] } : {})),
          set: vi.fn(async (obj: Record<string, string>) => Object.assign(storage, obj)),
        },
      },
    };
  });

  it('creates a UUID on first call and persists it', async () => {
    const id = await readOrCreateSwSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage['_session.id']).toBe(id);
  });

  it('reuses the persisted UUID on subsequent calls', async () => {
    const a = await readOrCreateSwSessionId();
    const b = await readOrCreateSwSessionId();
    expect(a).toBe(b);
  });
});
