import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  AGENT_NAME_IN_USE_PREFIX,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../src/scoops/agent-bridge.js';
import {
  type CuratorVfs,
  curationBasePath,
  curationDraftPath,
  curationStatusPath,
  curatorAgentName,
  curatorScratchDir,
  DEFAULT_MEMORY_MD,
  runAgenticMemoryPass,
} from '../../src/scoops/agentic-memory.js';
import { CONE_MEMORY_PATH, computeBudget } from '../../src/scoops/cone-memory-budget.js';

const ARCHIVE_PATH = '/sessions/2026-08-05-memory.md';

const DRAFT_PATH = curationDraftPath(ARCHIVE_PATH);
const CURATION_DIR = '/sessions/.curation/2026-08-05-memory.md';
const BASE_ALLOWED_COMMANDS = [
  'awk',
  'cat',
  'cp',
  'cut',
  'date',
  'diff',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'jq',
  'ls',
  'mkdir',
  'mount',
  'mv',
  'nl',
  'od',
  'printf',
  'readlink',
  'sed',
  'sort',
  'stat',
  'tail',
  'touch',
  'tr',
  'uniq',
  'upskill',
  'wc',
  'xxd',
];

interface FakeVfs extends CuratorVfs {
  writes: Map<string, string>;
}

function fakeVfs(content: string | Error, liveMemory?: string): FakeVfs {
  const writes = new Map<string, string>();
  return {
    writes,
    readFile: vi.fn(async (path: string) => {
      if (path === '/shared/MEMORY.md') {
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
    return { finalText: 'done', exitCode: 0 };
  });
}

describe('runAgenticMemoryPass', () => {
  beforeEach(() => resetLoggerDedupForTests());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads custom MEMORY.md parameters and substitutes known placeholders', async () => {
    const memoryMd = `---
writablePaths: [/workspace/, /knowledge/]
visiblePaths:
  - /sessions/
  - /shared/
  - /knowledge/
allowedCommands: [cat, grep, wc, custom-text]
model: claude-sonnet-4-6
timeoutSeconds: 45
---
Memory={{MEMORY_PATH}} archive={{SESSION_ARCHIVE_PATH}} count={{SESSION_COUNT}} budget={{BUDGET_CHARS}} today={{TODAY}} unknown={{KEEP_ME}}`;
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 30,
      today: '2026-08-06',
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    const options = spawn.mock.calls[0][0];
    expect(options).toMatchObject({
      cwd: '/workspace',

      writablePaths: ['/workspace/', '/knowledge/', DRAFT_PATH],
      visiblePaths: ['/sessions/', '/shared/', '/knowledge/', `${CURATION_DIR}/`],
      allowedCommands: [...BASE_ALLOWED_COMMANDS, 'custom-text'],
      modelId: 'claude-sonnet-4-6',

      successReceiptPath: '/sessions/.curated/2026-08-05-memory.md',

      mergeOnSuccess: {
        targetPath: CONE_MEMORY_PATH,
        basePath: curationBasePath(ARCHIVE_PATH),
        draftPath: DRAFT_PATH,
      },
      outcomeReceiptPath: curationStatusPath(ARCHIVE_PATH),

      maxWallClockMs: 45_000,
    });
    expect(options.prompt).toBe(
      `Memory=${DRAFT_PATH} archive=${ARCHIVE_PATH} count=30 budget=${computeBudget(30)} today=2026-08-06 unknown={{KEEP_ME}}`
    );
  });

  it('persists a durable transcript under the fixed memory-curator name', async () => {
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 3,
      today: '2026-08-06',
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    expect(spawn.mock.calls[0][0]).toMatchObject({
      persistSession: true,
      name: 'memory-curator',

      exclusiveWith: ['memory-dreamer'],

      maxWallClockMs: 1_200_000,
    });
  });

  it('passes whole-file budget and freshness rules to the curator', async () => {
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 4,
      today: '2026-08-06',
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    const prompt = spawn.mock.calls[0][0].prompt;
    expect(prompt).toContain("Today's date is 2026-08-06");
    expect(prompt).toContain('Every part of the file is editable and counts toward the budget');
    expect(prompt).toContain(
      `hard budget of ${computeBudget(4)} characters, with no exempt region`
    );
    expect(prompt).toContain('Prioritize re-verifying the oldest-dated sections');
    expect(prompt).toContain('Treat undated headings as maximally stale');

    expect(prompt).toContain('should finish in well under 10 minutes');
    expect(prompt).not.toContain('Preserve the user-authored header');
  });

  it('sends the entry grammar — provenance and supersession — to the curator', async () => {
    const spawn = successSpawn();

    await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 4,
      today: '2026-08-06',
    });

    const prompt = spawn.mock.calls[0][0].prompt;
    expect(prompt).toContain('`human:` for what the user said');
    expect(prompt).toContain('`process:` for what you inferred');
    expect(prompt).toContain('Version-pin claims that can rot');
    expect(prompt).toContain('Never record a confidence score');
    expect(prompt).toContain('`stale_after: YYYY-MM-DD`, an absolute date, never a duration');
    expect(prompt).toContain('Supersede, never append.');
    expect(prompt).toContain('- not: <refuted claim> — why: <evidence> — instead: <correction>');
  });

  it('accepts undated headings in a custom curator prompt', async () => {
    const spawn = successSpawn();
    const memoryMd = `---
timeoutSeconds: 5
---
# Curator

## Existing instructions

Curate {{MEMORY_PATH}} on {{TODAY}}.`;

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
      today: '2026-08-06',
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    expect(spawn.mock.calls[0][0].prompt).toContain('## Existing instructions');
    expect(spawn.mock.calls[0][0].prompt).toContain(`Curate ${DRAFT_PATH} on 2026-08-06.`);
  });

  it('strips block-array comments and preserves quoted inline commas', async () => {
    const memoryMd = `---
writablePaths: [/workspace/, "/knowledge/lars,rebecca/"]
visiblePaths:
  - /sessions/ # durable archives
  - "/shared/#reference"
allowedCommands:
  - cat # read files
---
Curate {{MEMORY_PATH}}.`;
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    expect(spawn.mock.calls[0][0]).toMatchObject({
      writablePaths: ['/workspace/', '/knowledge/lars,rebecca/', DRAFT_PATH],
      visiblePaths: ['/sessions/', '/shared/#reference', `${CURATION_DIR}/`],
      allowedCommands: BASE_ALLOWED_COMMANDS,
    });
  });

  it('preserves the base command set when frontmatter lists only a subset', async () => {
    const memoryMd = `---
allowedCommands: [cat, grep]
---
Curate {{MEMORY_PATH}}.`;
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    expect(spawn.mock.calls[0][0].allowedCommands).toEqual(BASE_ALLOWED_COMMANDS);
  });

  it.each(['awk', 'cp', 'echo', 'printf', 'sort'])(
    'grants %s from the base set even when frontmatter omits it',
    async (command) => {
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(`---\nallowedCommands: [cat]\n---\nCurate {{MEMORY_PATH}}.`),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
      });

      expect(spawn.mock.calls[0][0].allowedCommands).toContain(command);
    }
  );

  it('spawns with a reasoning level by default', async () => {
    const spawn = successSpawn();

    await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs('---\nallowedCommands: [cat]\n---\nCurate {{MEMORY_PATH}}.'),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(spawn.mock.calls[0][0].thinkingLevel).toBe('medium');
  });

  it('honours a frontmatter thinkingLevel override', async () => {
    const spawn = successSpawn();

    await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs('---\nthinkingLevel: high\n---\nCurate {{MEMORY_PATH}}.'),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(spawn.mock.calls[0][0].thinkingLevel).toBe('high');
  });

  it('rejects an unknown thinkingLevel and falls back to the built-in default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = successSpawn();

    await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs('---\nthinkingLevel: turbo\n---\nCurate {{MEMORY_PATH}}.'),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(spawn.mock.calls[0][0].thinkingLevel).toBe('medium');
    warn.mockRestore();
  });

  it('tells the curator not to read the archive whole', () => {
    expect(DEFAULT_MEMORY_MD).toMatch(/Never `cat` the archive/);
    expect(DEFAULT_MEMORY_MD).toContain('slicc:session-data');
  });

  it('grants every command the seeded curator prompt is configured to use', async () => {
    const seeded = DEFAULT_MEMORY_MD.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const seededCommands = seeded
      .match(/allowedCommands:\n((?:\s+-\s+\S+\n)+)/)?.[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean);
    expect(seededCommands?.length).toBeGreaterThan(0);
    expect(BASE_ALLOWED_COMMANDS).toEqual(expect.arrayContaining(seededCommands ?? []));
  });

  it.each([
    ['an unquoted comma in an inline path', 'writablePaths: [/workspace/, /home/lars,rebecca/]'],
    ['a bare root writable path', 'writablePaths: [/]'],
  ])('falls back safely for %s', async (_name, frontmatter) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(`---\n${frontmatter}\n---\nCurate {{MEMORY_PATH}}.`),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: true, report: 'done' });
    expect(warn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][0].writablePaths).toEqual([DRAFT_PATH]);
    expect(spawn.mock.calls[0][0].mergeOnSuccess?.targetPath).toBe(CONE_MEMORY_PATH);
  });

  it('uses the built-in default and warns when MEMORY.md is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(new Error('ENOENT')),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 2,
    });

    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();

    expect(spawn.mock.calls[0][0]).toMatchObject({
      cwd: '/workspace',
      writablePaths: [DRAFT_PATH],
      visiblePaths: ['/sessions/', '/shared/', '/workspace/', `${CURATION_DIR}/`],
      notifyOnComplete: true,
      mergeOnSuccess: {
        targetPath: CONE_MEMORY_PATH,
        basePath: curationBasePath(ARCHIVE_PATH),
        draftPath: DRAFT_PATH,
      },
    });
    expect(spawn.mock.calls[0][0].prompt).toContain(
      'Organize retained information into concise per-topic'
    );
  });

  it.each([
    ['malformed frontmatter', '---\nwritablePaths: [relative]\n---\nbroken'],
    ['empty template', '---\ntimeoutSeconds: 5\n---\n'],
  ])('falls back for %s', async (_name, content) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(content),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][0].prompt).toContain(DRAFT_PATH);
  });

  it('seeds the base snapshot and the draft from the live memory file', async () => {
    const spawn = successSpawn();
    const vfs = fakeVfs(DEFAULT_MEMORY_MD, '# Memory\n\n## Facts (2026-08-01)\n');

    const result = await runAgenticMemoryPass({
      spawn,
      vfs,
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: true, report: 'done' });

    expect(vfs.writes.get(curationBasePath(ARCHIVE_PATH))).toBe(
      '# Memory\n\n## Facts (2026-08-01)\n'
    );
    expect(vfs.writes.get(DRAFT_PATH)).toBe('# Memory\n\n## Facts (2026-08-01)\n');
  });

  it('seeds empty base and draft when no live memory exists yet', async () => {
    const spawn = successSpawn();
    const vfs = fakeVfs(DEFAULT_MEMORY_MD);

    await runAgenticMemoryPass({
      spawn,
      vfs,
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(vfs.writes.get(curationBasePath(ARCHIVE_PATH))).toBe('');
    expect(vfs.writes.get(DRAFT_PATH)).toBe('');
  });

  it('falls back safely (nothing spawned) when snapshot seeding fails', async () => {
    const spawn = successSpawn();
    const vfs = fakeVfs(DEFAULT_MEMORY_MD);
    vfs.writeFile = vi.fn(async () => {
      throw new Error('disk full');
    });

    const result = await runAgenticMemoryPass({
      spawn,
      vfs,
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'snapshot: disk full',
      legacyFallbackSafe: true,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns ok:false when spawn throws', async () => {
    const spawn = vi.fn(async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => {
      throw new Error('bridge unavailable');
    });

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'bridge unavailable',
      legacyFallbackSafe: true,
    });
  });

  it('returns ok:false for a non-zero agent exit', async () => {
    const spawn = vi.fn(async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => {
      return { finalText: 'curation failed', exitCode: 1 };
    });

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toEqual({ ok: false, reason: 'curation failed', legacyFallbackSafe: true });
  });

  it('defers (legacyFallbackSafe:false) when the curator name is already in use', async () => {
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: `${AGENT_NAME_IN_USE_PREFIX}: memory-curator`,
        exitCode: 1,
      })
    );

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(DEFAULT_MEMORY_MD),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    expect(result).toMatchObject({ ok: false, legacyFallbackSafe: false });
  });

  it('returns ok:false when the configured timeout elapses', async () => {
    vi.useFakeTimers();
    const memoryMd = `---\ntimeoutSeconds: 1\n---\nCurate {{MEMORY_PATH}}.`;
    const spawn = vi.fn(
      (_options: AgentSpawnOptions) => new Promise<AgentSpawnResult>(() => undefined)
    );

    const pass = runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });

    await vi.advanceTimersByTimeAsync(1000 + 30_000);

    await expect(pass).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      legacyFallbackSafe: false,
    });
  });

  it('clamps timeoutSeconds to the 1200-second maximum', async () => {
    vi.useFakeTimers();
    const memoryMd = `---\ntimeoutSeconds: 9999\n---\nCurate {{MEMORY_PATH}}.`;
    const spawn = vi.fn(
      (_options: AgentSpawnOptions) => new Promise<AgentSpawnResult>(() => undefined)
    );

    const pass = runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 1,
    });
    await vi.advanceTimersByTimeAsync(1_199_999 + 30_000);
    let settled = false;
    void pass.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pass).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      legacyFallbackSafe: false,
    });
  });

  describe('per cone (#2271)', () => {
    const BETA = { folder: 'cone-beta', jid: 'cone_beta' };

    it("curates the extra cone's own memory file, in its own workspace", async () => {
      const spawn = successSpawn();

      const result = await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 3,
        today: '2026-08-22',
        cone: BETA,
      });

      expect(result).toEqual({ ok: true, report: 'done' });
      const options = spawn.mock.calls[0][0];
      expect(options).toMatchObject({
        cwd: '/cones/cone-beta/workspace',

        writablePaths: [DRAFT_PATH],
        mergeOnSuccess: {
          targetPath: '/cones/cone-beta/CLAUDE.md',
          basePath: curationBasePath(ARCHIVE_PATH),
          draftPath: DRAFT_PATH,
        },

        parentJid: 'cone_beta',

        name: 'memory-curator-cone-beta',
      });

      expect(options.visiblePaths).toEqual([
        '/sessions/',
        '/shared/',
        '/cones/cone-beta/workspace/',
        '/workspace/skills/',
        `${CURATION_DIR}/`,
      ]);
      expect(options.prompt).toContain(DRAFT_PATH);
      expect(options.prompt).not.toContain('/workspace/CLAUDE.md');
    });

    it("sends the extra cone's drafts to its OWN scratch folder", async () => {
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 3,
        cone: BETA,
      });

      const prompt = spawn.mock.calls[0][0].prompt;
      const scratch = curatorScratchDir('cone-beta');
      expect(scratch).toBe('/scoops/agent-memory-curator-cone-beta');
      expect(prompt).toContain(scratch);
      expect(prompt).not.toContain('/scoops/agent-memory-curator/');

      expect(prompt).not.toContain(`${scratch}-cone-beta`);
    });

    it('does not double-substitute {{SCRATCH_DIR}} under an extra cone', async () => {
      const cone = { folder: 'cone-slicc-engineering', jid: 'cone_slicc_engineering' };
      const scratch = curatorScratchDir(cone.folder);
      const doubled = `${scratch}-cone-slicc-engineering`;
      expect(scratch).toBe('/scoops/agent-memory-curator-cone-slicc-engineering');
      expect(doubled).toBe(
        '/scoops/agent-memory-curator-cone-slicc-engineering-cone-slicc-engineering'
      );

      const memoryMd = `---\ntimeoutSeconds: 60\n---\nDraft in \`{{SCRATCH_DIR}}/draft.md\`, then write {{MEMORY_PATH}}.`;
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(memoryMd),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
        cone,
      });

      const prompt = spawn.mock.calls[0][0].prompt;
      expect(prompt).toBe(`Draft in \`${scratch}/draft.md\`, then write ${DRAFT_PATH}.`);
      expect(prompt).not.toContain(doubled);
    });

    it('rewrites a legacy MEMORY.md that spells the primary scratch folder out', async () => {
      const memoryMd = `---\ntimeoutSeconds: 60\n---\nDraft in \`/scoops/agent-memory-curator/draft.md\`, then write {{MEMORY_PATH}}.`;
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(memoryMd),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
        cone: BETA,
      });

      expect(spawn.mock.calls[0][0].prompt).toBe(
        `Draft in \`/scoops/agent-memory-curator-cone-beta/draft.md\`, then write ${DRAFT_PATH}.`
      );
    });

    it('leaves the primary cone byte-identical when named explicitly', async () => {
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 3,
        today: '2026-08-22',
        cone: { folder: 'cone' },
      });

      const options = spawn.mock.calls[0][0];
      expect(curatorAgentName('cone')).toBe('memory-curator');
      expect(options).toMatchObject({
        cwd: '/workspace',
        writablePaths: [DRAFT_PATH],
        name: 'memory-curator',
        mergeOnSuccess: {
          targetPath: CONE_MEMORY_PATH,
          basePath: curationBasePath(ARCHIVE_PATH),
          draftPath: DRAFT_PATH,
        },
      });
      expect(options.visiblePaths).toEqual([
        '/sessions/',
        '/shared/',
        '/workspace/',
        `${CURATION_DIR}/`,
      ]);
      expect(options.parentJid).toBeUndefined();
      expect(options.prompt).toContain('/scoops/agent-memory-curator/');
    });

    it('curates a cone whose folder carries digits (name stays spawnable)', async () => {
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
        cone: { folder: 'cone-beta-2' },
      });

      const options = spawn.mock.calls[0][0];
      expect(options.name).toBe('memory-curator-cone-beta-2');
      expect(options.name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(options.writablePaths).toEqual([DRAFT_PATH]);
      expect(options.mergeOnSuccess?.targetPath).toBe('/cones/cone-beta-2/CLAUDE.md');
    });

    it('falls back to the primary curator name for an unusable folder', async () => {
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(DEFAULT_MEMORY_MD),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
        cone: { folder: 'Cone_Weird!' },
      });

      const options = spawn.mock.calls[0][0];
      expect(options.name).toBe('memory-curator');
      expect(options.writablePaths).toEqual([DRAFT_PATH]);
      expect(options.mergeOnSuccess?.targetPath).toBe('/cones/Cone_Weird!/CLAUDE.md');
    });

    it('keeps an explicitly configured non-workspace path unrebased', async () => {
      const memoryMd = `---
writablePaths: [/knowledge/notes.md]
visiblePaths: [/sessions/, /knowledge/]
---
Curate {{MEMORY_PATH}}.`;
      const spawn = successSpawn();

      await runAgenticMemoryPass({
        spawn,
        vfs: fakeVfs(memoryMd),
        sessionArchivePath: ARCHIVE_PATH,
        sessionCount: 1,
        cone: BETA,
      });

      expect(spawn.mock.calls[0][0]).toMatchObject({
        writablePaths: ['/knowledge/notes.md', DRAFT_PATH],
        visiblePaths: ['/sessions/', '/knowledge/', `${CURATION_DIR}/`],
      });
    });
  });
});
