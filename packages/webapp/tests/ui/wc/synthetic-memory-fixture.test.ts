import {
  mountSyntheticMemoryFixture,
  SYNTHETIC_MEMORY_MARKDOWN,
  SYNTHETIC_MEMORY_PATH,
} from '@slicc/webcomponents/memory/synthetic-fixture';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';

const BULLET_WITH_CONTINUATIONS = /^- (.*(?:\n {2,}.*)*)/gm;

function fixtureBullets(): string[] {
  return [...SYNTHETIC_MEMORY_MARKDOWN.matchAll(BULLET_WITH_CONTINUATIONS)].map((match) =>
    match[1].replace(/\n\s+/g, ' ')
  );
}

describe('synthetic memory fixture', () => {
  it('reproduces the production document shape without production data', () => {
    const bullets = fixtureBullets();
    const firstBulletAt = SYNTHETIC_MEMORY_MARKDOWN.indexOf('\n- ');
    const header = SYNTHETIC_MEMORY_MARKDOWN.slice(0, firstBulletAt);
    const typical = bullets.filter((bullet) => bullet.length >= 60 && bullet.length <= 200);
    const longest = Math.max(...bullets.map((bullet) => bullet.length));

    expect(header).toContain('# Memory\nRole:');
    expect(header).toContain('\nFolder:');
    expect(header).toContain('\nCreated:');
    expect(SYNTHETIC_MEMORY_MARKDOWN.match(/^## /gm)?.length).toBeGreaterThanOrEqual(8);
    expect(SYNTHETIC_MEMORY_MARKDOWN).toMatch(/^### /m);
    expect(bullets).toHaveLength(100);
    expect(typical.length).toBeGreaterThanOrEqual(60);
    expect(bullets.filter((bullet) => bullet.length < 64).length).toBeGreaterThanOrEqual(4);
    expect(longest).toBeGreaterThanOrEqual(900);
    expect(longest).toBeLessThanOrEqual(1_300);
    expect(SYNTHETIC_MEMORY_MARKDOWN).toContain('https://example.invalid/reference');
    expect(SYNTHETIC_MEMORY_MARKDOWN).toContain('<preview mode="safe">');
  });

  it('mounts the raw markdown through the shared typed helper', async () => {
    const fs = await VirtualFS.create({ dbName: 'synthetic-memory-fixture', wipe: true });
    try {
      await mountSyntheticMemoryFixture(fs);
      expect(await fs.readFile(SYNTHETIC_MEMORY_PATH, { encoding: 'utf-8' })).toBe(
        SYNTHETIC_MEMORY_MARKDOWN
      );
    } finally {
      await fs.dispose();
    }
  });
});
