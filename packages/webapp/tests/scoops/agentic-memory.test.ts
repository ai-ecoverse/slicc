import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/core/logger.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import { DEFAULT_MEMORY_MD, runAgenticMemoryPass } from '../../src/scoops/agentic-memory.js';
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
    });
    expect(options.prompt).toBe(
      `Memory=${CONE_MEMORY_PATH} archive=${ARCHIVE_PATH} count=30 budget=${computeBudget(30)} today=2026-08-06 unknown={{KEEP_ME}}`
    );
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
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pass).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      legacyFallbackSafe: false,
    });
  });

  it('clamps timeoutSeconds to the 600-second maximum', async () => {
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
    await vi.advanceTimersByTimeAsync(599_999);
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
});
