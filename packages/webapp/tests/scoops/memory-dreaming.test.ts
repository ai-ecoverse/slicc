import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import {
  type CuratorVfs,
  curationBasePath,
  curationDraftPath,
  curationStatusPath,
  DEFAULT_DREAM_TIMEOUT_SECONDS,
  DEFAULT_MEMORY_MD,
  MAX_DREAM_TIMEOUT_SECONDS,
  MEMORY_INSTRUCTIONS_PATH,
} from '../../src/scoops/agentic-memory.js';
import { CONE_MEMORY_PATH } from '../../src/scoops/cone-memory-budget.js';
import {
  dreamerAgentName,
  dreamStateKey,
  runMemoryDreamPass,
} from '../../src/scoops/memory-dreaming.js';

const TODAY = '2026-09-11';
// The synthetic "archive" the shared machinery keys its state by — there is
// no file behind it, but the curation dir, draft, and receipts all derive
// from its basename.
const STATE_PATH = `/sessions/${dreamStateKey(TODAY, 'cone')}`;

interface FakeVfs extends CuratorVfs {
  writes: Map<string, string>;
}

/**
 * Serves `content` at `/etc/MEMORY.md` (or throws it); other reads get
 * what the pass wrote there, the optional `liveMemory`, or ENOENT.
 */
function fakeVfs(content: string | Error, liveMemory?: string): FakeVfs {
  const writes = new Map<string, string>();
  return {
    writes,
    readFile: vi.fn(async (path: string) => {
      if (path === MEMORY_INSTRUCTIONS_PATH) {
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
    expect(dreamStateKey('2026-09-11', 'cone-x')).toBe('dream-2026-09-11-cone-x.md');
  });
});

describe('runMemoryDreamPass', () => {
  beforeEach(() => resetLoggerDedupForTests());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the shared pass under the dreamer name with the shared MEMORY.md', async () => {
    const memoryMd = `---
writablePaths: [/workspace/CLAUDE.md]
visiblePaths: [/sessions/, /shared/, /workspace/]
timeoutSeconds: 300
dreamTimeoutSeconds: 900
---
{{TASK}}
Dream over {{MEMORY_PATH}}: {{SESSION_COUNT}} sessions, budget {{BUDGET_CHARS}}, today {{TODAY}}, archive {{SESSION_ARCHIVE_PATH}}, {{TIMEOUT_MINUTES}} min.`;
    const spawn = successSpawn();

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(memoryMd, '# memories\n'),
      sessionCount: 12,
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, report: 'merged 3 sections' });
    const options = spawn.mock.calls[0][0];
    expect(options).toMatchObject({
      name: 'memory-dreamer',
      // A curator over the same file must not be in flight (bridge `exclusiveWith`).
      exclusiveWith: ['memory-curator'],
      // The staged draft substitutes for the live memory file; the bridge
      // three-way-merges it back onto CONE_MEMORY_PATH on exit 0.
      writablePaths: [curationDraftPath(STATE_PATH)],
      mergeOnSuccess: {
        targetPath: CONE_MEMORY_PATH,
        basePath: curationBasePath(STATE_PATH),
        draftPath: curationDraftPath(STATE_PATH),
      },
      outcomeReceiptPath: curationStatusPath(STATE_PATH),
      // The dream runs under `dreamTimeoutSeconds`, not the curation bound.
      maxWallClockMs: 900_000,
    });
    // The prompt is MEMORY.md's, with the dreamer's placeholders filled —
    // {{MEMORY_PATH}} redirected to the staged draft, not the live file.
    expect(options.prompt).toContain(`Dream over ${curationDraftPath(STATE_PATH)}`);
    expect(options.prompt).toContain('12 sessions');
    expect(options.prompt).toContain(`today ${TODAY}`);
    expect(options.prompt).toContain('15 min.');
    expect(options.prompt).not.toContain('{{');
    // The task names the pass and keeps the mining recipes off the synthetic
    // state key, which no archive backs.
    expect(options.prompt).toContain('**Consolidation pass**');
    expect(options.prompt).toContain('archive (no session archive this pass)');
    expect(options.prompt).not.toContain(STATE_PATH);
  });

  it('runs a dream under the long default bound when the document sets none', async () => {
    const spawn = successSpawn();

    await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs('---\ntimeoutSeconds: 60\n---\nDream {{MEMORY_PATH}}.', '# memories\n'),
      sessionCount: 1,
      today: TODAY,
    });

    expect(spawn.mock.calls[0][0]).toMatchObject({
      maxWallClockMs: DEFAULT_DREAM_TIMEOUT_SECONDS * 1000,
    });
    expect(DEFAULT_DREAM_TIMEOUT_SECONDS).toBe(3600);
  });

  it('clamps dreamTimeoutSeconds to its own maximum', async () => {
    const spawn = successSpawn();

    await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs('---\ndreamTimeoutSeconds: 99999\n---\nDream {{MEMORY_PATH}}.', '# memories\n'),
      sessionCount: 1,
      today: TODAY,
    });

    expect(spawn.mock.calls[0][0]).toMatchObject({
      maxWallClockMs: MAX_DREAM_TIMEOUT_SECONDS * 1000,
    });
    expect(MAX_DREAM_TIMEOUT_SECONDS).toBe(7200);
  });

  it('appends the task to a document that predates {{TASK}}', async () => {
    const spawn = successSpawn();

    await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs('---\ntimeoutSeconds: 60\n---\nDream {{MEMORY_PATH}}.', '# memories\n'),
      sessionCount: 1,
      today: TODAY,
    });

    const prompt = spawn.mock.calls[0][0].prompt;
    expect(
      prompt.startsWith(`Dream ${curationDraftPath(STATE_PATH)}.\n\n**Consolidation pass**`)
    ).toBe(true);
  });

  // The bundled contract carries the P6 supersession duties and the wiki
  // escape valve for every pass: contradictions resolve to one version (with
  // the loser optionally preserved as negative knowledge), contradiction
  // counts are reported so the pass is falsifiable, expired stale_after
  // entries are re-verified or dropped, and over-budget reference knowledge
  // moves to /shared/wiki/ — which is why the shipped frontmatter grants it.
  it('bundled MEMORY.md instructs supersession, stale_after handling, and the wiki move', () => {
    expect(DEFAULT_MEMORY_MD).toContain('Supersede contradictions.');
    expect(DEFAULT_MEMORY_MD).toContain(
      '- not: <refuted claim> — why: <evidence> — instead: <correction>'
    );
    expect(DEFAULT_MEMORY_MD).toContain('Count contradictory claim pairs before and after');
    expect(DEFAULT_MEMORY_MD).toContain('`stale_after: YYYY-MM-DD` date has passed');
    expect(DEFAULT_MEMORY_MD).toContain('confidence score');
    expect(DEFAULT_MEMORY_MD).toContain('Move knowledge to the wiki.');
    expect(DEFAULT_MEMORY_MD).toContain('/shared/wiki/WIKI.md');
    // The frontmatter grant that makes the wiki move possible.
    expect(DEFAULT_MEMORY_MD).toContain('- /shared/wiki/');
    // The slot the runtime fills with which pass this is, and both bounds.
    expect(DEFAULT_MEMORY_MD).toContain('{{TASK}}');
    expect(DEFAULT_MEMORY_MD).toMatch(/^timeoutSeconds: \d+$/m);
    expect(DEFAULT_MEMORY_MD).toMatch(/^dreamTimeoutSeconds: \d+$/m);
  });

  it('falls back to the bundled MEMORY.md when the VFS copy is unreadable', async () => {
    const spawn = successSpawn();

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(new Error('boom'), '# memories\n'),
      sessionCount: 3,
      today: TODAY,
    });

    expect(result).toEqual({ ok: true, report: 'merged 3 sections' });
    const options = spawn.mock.calls[0][0];
    // A distinctive line from the bundled document proves which instructions ran.
    expect(DEFAULT_MEMORY_MD).toContain('Consolidating (every pass)');
    expect(options.prompt).toContain('Consolidating (every pass)');
    expect(options.prompt).toContain('**Consolidation pass**');
    expect(options.prompt).not.toContain('{{BUDGET_CHARS}}');
    expect(options.prompt).not.toContain('{{TASK}}');
  });

  it('dreams an extra cone under its own name against its own memory file', async () => {
    const memoryMd = `---
writablePaths: [/workspace/CLAUDE.md]
---
Rewrite {{MEMORY_PATH}}.`;
    const spawn = successSpawn();
    const statePath = `/sessions/${dreamStateKey(TODAY, 'cone-research')}`;

    const result = await runMemoryDreamPass({
      spawn,
      vfs: fakeVfs(memoryMd, '# research memories\n'),
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
