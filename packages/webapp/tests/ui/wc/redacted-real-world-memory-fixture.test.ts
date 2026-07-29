// @vitest-environment jsdom

import {
  mountRedactedRealWorldMemoryFixture,
  REDACTED_REAL_WORLD_MEMORY_MARKDOWN,
  REDACTED_REAL_WORLD_MEMORY_PATH,
} from '@slicc/webcomponents/memory/redacted-real-world-fixture';
import { describe, expect, it } from 'vitest';
import { MEMORY_TITLE_MAX, parseMemoryRows } from '../../../src/ui/wc/wc-memory.js';

const count = (pattern: RegExp): number =>
  REDACTED_REAL_WORLD_MEMORY_MARKDOWN.match(pattern)?.length ?? 0;

describe('redacted real-world memory fixture', () => {
  it('preserves the recorded production structure', () => {
    const lines = REDACTED_REAL_WORLD_MEMORY_MARKDOWN.trimEnd().split('\n');

    expect(lines).toHaveLength(142);
    expect(count(/^# /gm)).toBe(1);
    expect(count(/^## /gm)).toBe(12);
    expect(count(/^### /gm)).toBe(4);
    expect(count(/^\s*[-*+]\s+/gm)).toBe(105);
    expect(lines.filter((line) => line === '')).toHaveLength(17);
    expect(
      lines.filter((line) => line && !/^#{1,6}\s/.test(line) && !/^\s*[-*+]\s+/.test(line))
    ).toHaveLength(3);
    expect(count(/\*\*/g)).toBe(98);
    expect(count(/`/g)).toBe(748);
    expect(Math.max(...lines.map((line) => line.length))).toBeGreaterThanOrEqual(1_100);
  });

  it('parses 105 bullets plus the preserved prose header', () => {
    expect(parseMemoryRows(REDACTED_REAL_WORLD_MEMORY_MARKDOWN)).toHaveLength(106);
  });

  it('hard-caps every real-world title and keeps overflow in the summary', () => {
    const rows = parseMemoryRows(REDACTED_REAL_WORLD_MEMORY_MARKDOWN);
    const maxTitleLength = Math.max(...rows.map((row) => row.title.length));
    expect(maxTitleLength).toBeGreaterThan(80);
    expect(maxTitleLength).toBeLessThanOrEqual(MEMORY_TITLE_MAX);
    expect(rows.filter((row) => row.title.length === maxTitleLength)).not.toHaveLength(0);
    expect(
      rows
        .filter((row) => row.title.length === maxTitleLength)
        .every((row) => row.summary.length > 0)
    ).toBe(true);
    expect(rows.filter((row) => row.title.endsWith(':'))).toHaveLength(0);
  });

  it('mounts the raw Markdown through the typed helper', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    await mountRedactedRealWorldMemoryFixture({
      writeFile: async (path, content): Promise<void> => {
        writes.push({ path, content });
      },
    });

    expect(writes).toEqual([
      {
        path: REDACTED_REAL_WORLD_MEMORY_PATH,
        content: REDACTED_REAL_WORLD_MEMORY_MARKDOWN,
      },
    ]);
  });
});
