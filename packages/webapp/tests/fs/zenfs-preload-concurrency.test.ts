import { WebAccess } from '@zenfs/dom';
import { describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

async function makeBackend() {
  const tree = Object.fromEntries(
    Array.from({ length: 8 }, (_, directory) => [
      `d${directory}`,
      Object.fromEntries(Array.from({ length: 8 }, (_, file) => [`f${file}`, 'data'])),
    ])
  );
  return WebAccess.create({ handle: createMutableDirectoryHandle(tree).handle });
}

describe('ZenFS preload concurrency across a directory tree', () => {
  it('bounds payload reads globally and preserves the synchronous cache', async () => {
    const backend = await makeBackend();
    const read = backend.read.bind(backend);
    let active = 0;
    let peak = 0;
    let finished = 0;
    vi.spyOn(backend, 'read').mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await read(...args);
        finished++;
      } finally {
        active--;
      }
    });
    await backend.ready();
    expect(peak).toBe(16);
    expect(finished).toBe(64);
    expect(active).toBe(0);
    for (const path of ['/d0/f0', '/d7/f7']) {
      const bytes = new Uint8Array(4);
      backend.readSync(path, bytes, 0, 4);
      expect(new TextDecoder().decode(bytes)).toBe('data');
    }
  });

  it('releases slots and drains every child before rejecting a failed preload', async () => {
    const backend = await makeBackend();
    const read = backend.read.bind(backend);
    const failure = new DOMException('Unreadable file', 'NotReadableError');
    let active = 0;
    let finished = 0;
    vi.spyOn(backend, 'read').mockImplementation(async (...args) => {
      active++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (args[0] === '/d0/f0') throw failure;
        await read(...args);
      } finally {
        finished++;
        active--;
      }
    });
    await expect(backend.ready()).rejects.toBe(failure);
    expect(active).toBe(0);
    expect(finished).toBe(64);
  });
});
