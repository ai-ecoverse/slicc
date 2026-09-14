// @vitest-environment jsdom

import {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_PATH,
  mountMachineWrittenMemoryFixture,
} from '@slicc/webcomponents/memory/machine-written-fixture';
import { describe, expect, it } from 'vitest';
import { parseMemoryRows } from '../../../src/ui/wc/wc-memory.js';

const BULLET = /^- /gm;
const APPEND_HEADING = /^## Auto-extracted \(([0-9]{4}-[0-9]{2}-[0-9]{2}), ([^)]+)\)$/gm;

describe('machine-written memory fixture', () => {
  it('mirrors repeated writer appends without invented tail headings', () => {
    const headings = [...MACHINE_WRITTEN_MEMORY_MARKDOWN.matchAll(APPEND_HEADING)];
    expect(MACHINE_WRITTEN_MEMORY_MARKDOWN.match(BULLET)).toHaveLength(100);
    expect(headings).toHaveLength(10);
    expect(new Set(headings.map((match) => match[1])).size).toBe(10);
    expect(new Set(headings.map((match) => match[2]))).toEqual(
      new Set(['compaction', 'new-session', 'pending-enrichment'])
    );
    expect(MACHINE_WRITTEN_MEMORY_MARKDOWN).not.toMatch(/^###/m);
    expect(MACHINE_WRITTEN_MEMORY_MARKDOWN).not.toMatch(/^## (?!Auto-extracted)/m);
  });

  it('degenerates to exactly one parsed section after restructure', () => {
    const rows = parseMemoryRows(MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN);
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.section))).toEqual(
      new Set(['Auto-extracted (consolidated)'])
    );
    expect(MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN.match(BULLET)).toHaveLength(100);
    expect(MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN.match(/^## /gm)).toHaveLength(1);
    expect(MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN).not.toMatch(/^###/m);
    expect(new Set(rows.map((row) => row.tag))).toEqual(new Set(['user', 'feedback', null]));
  });

  it('mounts either writer state through the typed helper', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const target = {
      writeFile: async (path: string, content: string): Promise<void> => {
        writes.push({ path, content });
      },
    };
    await mountMachineWrittenMemoryFixture(target);
    await mountMachineWrittenMemoryFixture(target, 'consolidated');
    expect(writes).toEqual([
      { path: MACHINE_WRITTEN_MEMORY_PATH, content: MACHINE_WRITTEN_MEMORY_MARKDOWN },
      {
        path: MACHINE_WRITTEN_MEMORY_PATH,
        content: MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
      },
    ]);
  });
});
