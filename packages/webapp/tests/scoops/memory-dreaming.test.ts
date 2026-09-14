import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import {
  type CuratorVfs,
  curationBasePath,
  curationDraftPath,
  curationStatusPath,
} from '../../src/scoops/agentic-memory.js';
import { CONE_MEMORY_PATH } from '../../src/scoops/cone-memory-budget.js';
import {
  DEFAULT_DREAMING_MD,
  DREAMING_INSTRUCTIONS_PATH,
  dreamerAgentName,
  dreamStateKey,
  runMemoryDreamPass,
} from '../../src/scoops/memory-dreaming.js';

const TODAY = '2026-09-11';

const STATE_PATH = `/sessions/${dreamStateKey(TODAY, 'cone')}`;

interface FakeVfs extends CuratorVfs {
  writes: Map<string, string>;
}

function fakeVfs(content: string | Error, liveMemory?: string): FakeVfs {
  const writes = new Map<string, string>();
  return {
    writes,
    readFile: vi.fn(async (path: string) => {
      if (path === DREAMING_INSTRUCTIONS_PATH) {
        if (content instanceof Error) throw content;
        return content;
      }
      const written = writes.get(path);
      if (written !== undefined) return written;
      if (liveMemory !== undefined) return liveMemory;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }),
    writeFile: vi.fn(async (path: string, body: string) => {
      writes.set(path, body);
    }),
    mkdir: vi.fn(async () => {}),
  };
}

function successSpawn() {
  return vi.fn(async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => {
    return { finalText: 'merged 3 sections', exitCode: 0 };
  });
}

describe('dreamerAgentName', () => {
  it('is fixed per cone so same-file dreams collide and cross-cone dreams do not', () => {
    expect(dreamerAgentName('cone')).toBe('memory-dreamer');
    expect(dreamerAgentName('cone-research')).toBe('memory-dreamer-cone-research');
  });
});

describe('dreamStateKey', () => {
  it('keys one state folder per cone per day', () => {
    expect(dreamStateKey('2026-09-11', 'cone')).toBe('dream-2026-09-11-cone.md');
    expect(dreamStateKey('2026-09-11', 'cone-research')).toBe('dream-2026-09-11-cone-research.md');
  });
});

describe('runMemoryDreamPass', () => {
  beforeEach(() => resetLoggerDedupForTests());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the shared pass under the dreamer name with DREAMING.md instructions', async () => {
    const dreamingMd = `---
writablePaths: [/workspace/CLAUDE.md]
visiblePaths: [/sessions/, /shared/, /workspace/]
timeoutSeconds: 900
---
Dream over {{MEMORY_PATH}}: {{SESSION_COUNT}} sessions, budget {{BUDGET_CHARS}}, today {{TODAY}}.`;
    const spawn = successSpawn();

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(dreamingMd, '# memories\n'),
      sessionCount: 12,
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, report: 'merged 3 sections' });
    const options = spawn.mock.calls[0][0];
    expect(options).toMatchObject({
      name: 'memory-dreamer',

      exclusiveWith: ['memory-curator'],

      writablePaths: [curationDraftPath(STATE_PATH)],
      mergeOnSuccess: {
        targetPath: CONE_MEMORY_PATH,
        basePath: curationBasePath(STATE_PATH),
        draftPath: curationDraftPath(STATE_PATH),
      },
      outcomeReceiptPath: curationStatusPath(STATE_PATH),
      maxWallClockMs: 900_000,
    });

    expect(options.prompt).toContain(`Dream over ${curationDraftPath(STATE_PATH)}`);
    expect(options.prompt).toContain('12 sessions');
    expect(options.prompt).toContain(`today ${TODAY}`);
    expect(options.prompt).not.toContain('{{');
  });

  it('bundled DREAMING.md instructs supersession, stale_after handling, and the wiki move', () => {
    expect(DEFAULT_DREAMING_MD).toContain('Supersede contradictions.');
    expect(DEFAULT_DREAMING_MD).toContain(
      '- not: <refuted claim> — why: <evidence> — instead: <correction>'
    );
    expect(DEFAULT_DREAMING_MD).toContain('Count contradictory claim pairs before and after');
    expect(DEFAULT_DREAMING_MD).toContain('`stale_after: YYYY-MM-DD` date has passed');
    expect(DEFAULT_DREAMING_MD).toContain('no confidence scores');
    expect(DEFAULT_DREAMING_MD).toContain('Move knowledge to the wiki.');
    expect(DEFAULT_DREAMING_MD).toContain('/shared/wiki/WIKI.md');

    expect(DEFAULT_DREAMING_MD).toContain('- /shared/wiki/');
  });

  it('falls back to the bundled DREAMING.md when the VFS copy is unreadable', async () => {
    const spawn = successSpawn();

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(new Error('boom'), '# memories\n'),
      sessionCount: 3,
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, report: 'merged 3 sections' });
    const options = spawn.mock.calls[0][0];

    expect(DEFAULT_DREAMING_MD).toContain('memory dreamer');
    expect(options.prompt).toContain('memory dreamer');
    expect(options.prompt).not.toContain('{{BUDGET_CHARS}}');
  });

  it('dreams an extra cone under its own name against its own memory file', async () => {
    const dreamingMd = `---
writablePaths: [/workspace/CLAUDE.md]
---
Rewrite {{MEMORY_PATH}}.`;
    const spawn = successSpawn();
    const statePath = `/sessions/${dreamStateKey(TODAY, 'cone-research')}`;

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(dreamingMd, '# research memories\n'),
      sessionCount: 5,
      cone: { folder: 'cone-research' },
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, report: 'merged 3 sections' });
    const options = spawn.mock.calls[0][0];
    expect(options).toMatchObject({
      name: 'memory-dreamer-cone-research',
      writablePaths: [curationDraftPath(statePath)],
      mergeOnSuccess: {
        targetPath: '/cones/cone-research/CLAUDE.md',
        basePath: curationBasePath(statePath),
        draftPath: curationDraftPath(statePath),
      },
    });
  });

  it('reports a failed pass without touching the live memory file', async () => {
    const spawn = vi.fn(async (): Promise<AgentSpawnResult> => {
      return { finalText: 'could not finish', exitCode: 1 };
    });
    const vfs = fakeVfs('Rewrite {{MEMORY_PATH}}.', '# memories\n');

    const result = await runMemoryDreamPass({ spawn, vfs, sessionCount: 2, today: TODAY });

    expect(result.ok).toBe(false);
    expect(vfs.writes.has(CONE_MEMORY_PATH)).toBe(false);
  });
});
