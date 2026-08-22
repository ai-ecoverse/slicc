import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import {
  AGENT_NAME_IN_USE_PREFIX,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../src/scoops/agent-bridge.js';
import {
  curatorAgentName,
  curatorScratchDir,
  DEFAULT_MEMORY_MD,
  runAgenticMemoryPass,
} from '../../src/scoops/agentic-memory.js';
import { CONE_MEMORY_PATH, computeBudget } from '../../src/scoops/cone-memory-budget.js';

const ARCHIVE_PATH = '/sessions/2026-08-05-memory.md';
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

function fakeVfs(content: string | Error): Pick<LocalVfsClient, 'readFile'> {
  return {
    readFile: vi.fn(async () => {
      if (content instanceof Error) throw content;
      return content;
    }),
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
      writablePaths: ['/workspace/', '/knowledge/'],
      visiblePaths: ['/sessions/', '/shared/', '/knowledge/'],
      allowedCommands: [...BASE_ALLOWED_COMMANDS, 'custom-text'],
      modelId: 'claude-sonnet-4-6',
      // Per-archive completion receipt the bridge writes on exit 0 —
      // the boot catch-up's crash-safe curator-finished signal (#1989).
      successReceiptPath: '/sessions/.curated/2026-08-05-memory.md',
      // timeoutSeconds becomes a REAL in-run wall-clock bound (#1972);
      // this fixture sets timeoutSeconds: 45.
      maxWallClockMs: 45_000,
    });
    expect(options.prompt).toBe(
      `Memory=${CONE_MEMORY_PATH} archive=${ARCHIVE_PATH} count=30 budget=${computeBudget(30)} today=2026-08-06 unknown={{KEEP_ME}}`
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
      // Shipped MEMORY.md sets timeoutSeconds: 1200 → a 20-minute wall-clock
      // ceiling, generous enough that a slow pass is not killed mid-write
      // and left over budget (#2263).
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
    // The soft time budget: aim to finish under 10 minutes (hard stop at 20).
    expect(prompt).toContain('should finish in well under 10 minutes');
    expect(prompt).not.toContain('Preserve the user-authored header');
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
    expect(spawn.mock.calls[0][0].prompt).toContain('Curate /workspace/CLAUDE.md on 2026-08-06.');
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
      writablePaths: ['/workspace/', '/knowledge/lars,rebecca/'],
      visiblePaths: ['/sessions/', '/shared/#reference'],
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

  // Observed live: a stale workspace whose seeded MEMORY.md predates the wider
  // list still escalated `awk`, `sort` and `echo` to the cone, which killed the
  // run. Missing commands do not fail — they raise a sudo request — so the base
  // set must cover them from code, independent of the on-disk frontmatter.
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

  // Spawned agents resolve an absent level to 'off'. Reasoning is what keeps the
  // turn count (and therefore the bill) down, so the curator must never inherit
  // that default silently.
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
    expect(spawn.mock.calls[0][0].writablePaths).toEqual(['/workspace/CLAUDE.md']);
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
    // The write grant is the memory file alone: the curator can run `upskill`,
    // and a `/workspace/` root would also let it install into
    // `/workspace/skills/`. `/workspace/` stays readable so it can orient.
    expect(spawn.mock.calls[0][0]).toMatchObject({
      cwd: '/workspace',
      writablePaths: ['/workspace/CLAUDE.md'],
      visiblePaths: ['/sessions/', '/shared/', '/workspace/'],
      notifyOnComplete: true,
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
    expect(spawn.mock.calls[0][0].prompt).toContain(CONE_MEMORY_PATH);
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
    // A prior curator (now up to a 20-minute window) still holds the fixed
    // `memory-curator` name, so this spawn is rejected before it runs. No run
    // released — a legacy append here would be clobbered by the running
    // namesake's whole-file rewrite, so the pass must NOT mark it safe; the
    // entry stays pending for boot catch-up instead.
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
    // The outer wait grants 30 s grace beyond the in-run bound (#1972),
    // so the pure-wait timeout fires at bound + grace.
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
        // The shipped MEMORY.md names the PRIMARY memory file; the pass
        // applies that same policy to this cone's own file instead.
        writablePaths: ['/cones/cone-beta/CLAUDE.md'],
        // Parented to the cone it curates, so an escalation reaches that
        // cone's approval router.
        parentJid: 'cone_beta',
        // A distinct name: two cones curate two different files and must not
        // collide on the fixed `memory-curator` name.
        name: 'memory-curator-cone-beta',
      });
      // `/workspace/` rebases to this cone's root; the shared skills library
      // is re-added because rebasing moved the only entry that covered it.
      expect(options.visiblePaths).toEqual([
        '/sessions/',
        '/shared/',
        '/cones/cone-beta/workspace/',
        '/workspace/skills/',
      ]);
      expect(options.prompt).toContain('/cones/cone-beta/CLAUDE.md');
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

      // The bridge derives the scratch folder from the agent name, so a
      // per-cone name moves it — and a MEMORY.md that predates
      // `{{SCRATCH_DIR}}` and spells the primary's out is rewritten rather
      // than sending every draft write into another agent's folder.
      const prompt = spawn.mock.calls[0][0].prompt;
      expect(curatorScratchDir('cone-beta')).toBe('/scoops/agent-memory-curator-cone-beta');
      expect(prompt).toContain('/scoops/agent-memory-curator-cone-beta');
      expect(prompt).not.toContain('/scoops/agent-memory-curator/');
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
        'Draft in `/scoops/agent-memory-curator-cone-beta/draft.md`, then write /cones/cone-beta/CLAUDE.md.'
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
        writablePaths: [CONE_MEMORY_PATH],
        name: 'memory-curator',
      });
      expect(options.visiblePaths).toEqual(['/sessions/', '/shared/', '/workspace/']);
      expect(options.parentJid).toBeUndefined();
      expect(options.prompt).toContain('/scoops/agent-memory-curator/');
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

      // Nothing under `/workspace/`, so nothing to rebase — a deliberate
      // configuration is left exactly as written, and the skills library is
      // NOT added because the original list never covered it either.
      expect(spawn.mock.calls[0][0]).toMatchObject({
        writablePaths: ['/knowledge/notes.md'],
        visiblePaths: ['/sessions/', '/knowledge/'],
      });
    });
  });
});
