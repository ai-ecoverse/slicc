import { describe, expect, it } from 'vitest';
import {
  computeBudget,
  isCurationDraftPath,
  isMemoryFilePath,
  isMemoryPassSandbox,
  MEMORY_BASE_CHARS,
  MEMORY_FILE_GUARD_MESSAGE,
  MEMORY_WRITE_TOOL_NAME,
} from '../../src/base/memory-budget.js';

describe('computeBudget', () => {
  it('grows logarithmically from the base allowance', () => {
    expect(computeBudget(0)).toBe(MEMORY_BASE_CHARS + 2000);
    expect(computeBudget(6)).toBe(MEMORY_BASE_CHARS + 6000);
    expect(computeBudget(-1)).toBe(computeBudget(0));
    expect(computeBudget(Number.NaN)).toBe(computeBudget(0));
  });
});

describe('isMemoryFilePath', () => {
  it('recognises every durable-memory file an agent can be pointed at', () => {
    for (const path of [
      '/workspace/CLAUDE.md',
      '/shared/CLAUDE.md',
      '/cones/cone-helix/CLAUDE.md',
      '/scoops/agent-memory-dreamer/CLAUDE.md',
      '/sessions/.curation/2026-09-16T01-16-15-298Z-title.md/draft.md',
      '/sessions/.curation/dream-2026-09-16-cone-helix.md/draft.md',
    ]) {
      expect(isMemoryFilePath(path), path).toBe(true);
    }
  });

  it('tolerates shell spellings without resolving them', () => {
    expect(isMemoryFilePath('/workspace//CLAUDE.md')).toBe(true);
    expect(isMemoryFilePath('/workspace/./CLAUDE.md')).toBe(true);
    expect(isMemoryFilePath('workspace/CLAUDE.md')).toBe(true);
    expect(isMemoryFilePath('/workspace/CLAUDE.md/')).toBe(true);
  });

  it('is not "any file named CLAUDE.md"', () => {
    for (const path of [
      '/workspace/slicc/CLAUDE.md',
      '/workspace/slicc/packages/webapp/CLAUDE.md',
      '/cones/cone-helix/workspace/CLAUDE.md',
      '/shared/wiki/CLAUDE.md',
      '/sessions/.curation/dream-x.md/base.md',
      '/workspace/claude.md',
      '/workspace/CLAUDE.md.bak',
    ]) {
      expect(isMemoryFilePath(path), path).toBe(false);
    }
  });

  it('names the tool in the guard message', () => {
    expect(MEMORY_FILE_GUARD_MESSAGE).toContain(MEMORY_WRITE_TOOL_NAME);
  });
});

describe('isMemoryPassSandbox (#3459)', () => {
  it('recognises a unit by its grant on a staged curation draft, however the bridge spells it', () => {
    expect(isCurationDraftPath('/sessions/.curation/dream-2026-09-24-cone.md/draft.md')).toBe(true);
    expect(isCurationDraftPath('/sessions/.curation/dream-2026-09-24-cone.md/draft.md/')).toBe(
      true
    );
    expect(isCurationDraftPath('/sessions/.curation/dream-x.md/base.md')).toBe(false);
    expect(isCurationDraftPath('/workspace/CLAUDE.md')).toBe(false);
    expect(
      isMemoryPassSandbox([
        '/sessions/.curation/2026-08-05-memory.md/draft.md/',
        '/scoops/agent-memory-curator/',
        '/tmp/',
      ])
    ).toBe(true);
    expect(isMemoryPassSandbox(['/scoops/agent-helper/', '/shared/', '/tmp/'])).toBe(false);
    expect(isMemoryPassSandbox([])).toBe(false);
  });
});
