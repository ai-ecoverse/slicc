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
  'cut',
  'date',
  'diff',
  'echo',
  'find',
  'grep',
  'head',
  'ls',
  'mkdir',
  'mv',
  'printf',
  'sed',
  'sort',
  'tail',
  'touch',
  'tr',
  'uniq',
  'wc',
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
Memory={{MEMORY_PATH}} archive={{SESSION_ARCHIVE_PATH}} count={{SESSION_COUNT}} budget={{BUDGET_CHARS}} unknown={{KEEP_ME}}`;
    const spawn = successSpawn();

    const result = await runAgenticMemoryPass({
      spawn,
      vfs: fakeVfs(memoryMd),
      sessionArchivePath: ARCHIVE_PATH,
      sessionCount: 30,
    });

    expect(result).toEqual({ ok: true });
    const options = spawn.mock.calls[0][0];
    expect(options).toMatchObject({
      cwd: '/workspace',
      writablePaths: ['/workspace/', '/knowledge/'],
      visiblePaths: ['/sessions/', '/shared/', '/knowledge/'],
      allowedCommands: [...BASE_ALLOWED_COMMANDS, 'custom-text'],
      modelId: 'claude-sonnet-4-6',
    });
    expect(options.prompt).toBe(
      `Memory=${CONE_MEMORY_PATH} archive=${ARCHIVE_PATH} count=30 budget=${computeBudget(30)} unknown={{KEEP_ME}}`
    );
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

    expect(result).toEqual({ ok: true });
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

    expect(result).toEqual({ ok: true });
    expect(spawn.mock.calls[0][0].allowedCommands).toEqual(BASE_ALLOWED_COMMANDS);
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

    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][0].writablePaths).toEqual(['/workspace/']);
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
      writablePaths: ['/workspace/'],
      visiblePaths: ['/sessions/', '/shared/'],
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
