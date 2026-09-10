/**
 * Scoop pre-compaction snapshots behind `memory-v2` (memory-management
 * report §2.2 / P2): a compacting scoop gets the same archive + pointer
 * treatment as a cone, written under its own sandbox
 * `/scoops/<folder>/sessions/` — never cone `/sessions`.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  type CompactionSnapshot,
  createCompactContext,
} from '../../src/core/context-compaction.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { scoopSessionsDir, snapshotLiveSession } from '../../src/scoops/live-session-snapshot.js';
import { parseFrozenArchive } from '../../src/transcript/frozen-archive-format.js';
import type { ArchiveVfs } from '../../src/transcript/frozen-archive-writer.js';

type TestMessage = { role: string; content: { type: string; text?: string }[] | string };
type CompactionSettingsArg = { enabled: boolean; reserveTokens: number; keepRecentTokens: number };

const mockCompleteSimple = vi.fn();
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, completeSimple: (...args: unknown[]) => mockCompleteSimple(...args) };
});
vi.mock('@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', () => ({
  estimateTokens: (msg: TestMessage) => {
    let chars = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content)
        if (block.type === 'text' && block.text) chars += block.text.length;
    }
    return Math.ceil(chars / 4);
  },
  shouldCompact: (tokens: number, window: number, settings: CompactionSettingsArg) =>
    settings.enabled && tokens > window - settings.reserveTokens,
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
}));

const mocks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
}));

vi.mock('../../src/core/feature-flags.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/feature-flags.js')>();
  return {
    ...actual,
    isFeatureEnabled: (id: string) => mocks.enabledFlags.has(id),
  };
});

const user = (text: string, timestamp: number): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp }) as AgentMessage;
const assistant = (text: string, timestamp: number): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    stopReason: 'stop',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'm',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }) as unknown as AgentMessage;

function fakeVfs(): ArchiveVfs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      const { FsError } = await import('../../src/fs/types.js');
      if (!files.has(path)) throw new FsError('ENOENT', `missing ${path}`, path);
      return files.get(path)!;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async mkdir(): Promise<void> {},
    async rm(path: string): Promise<void> {
      files.delete(path);
    },
    async flush(): Promise<void> {},
  };
}

const model = { id: 'm', provider: 'anthropic' } as unknown as Model<Api>;
const text = (role: 'user' | 'assistant', chars: number, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text: 'x'.repeat(chars) }], timestamp }) as AgentMessage;
/** Four ~3k-token messages against a 10k window / 1k reserve: over the threshold. */
const conversation = () => [
  text('user', 12_000, 1),
  text('assistant', 12_000, 2),
  text('user', 12_000, 3),
  text('assistant', 12_000, 4),
];
const textOf = (message: AgentMessage): string =>
  ((message as { content: { text: string }[] }).content[0] as { text: string }).text;

describe('scoop pre-compaction snapshots (memory-v2)', () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mockCompleteSimple.mockReset();
    mockCompleteSimple.mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'SUMMARY' }],
    });
  });

  it('writes the archive under /scoops/<folder>/sessions/ and the pointer resolves', async () => {
    const vfs = fakeVfs();
    const folder = 'research-worker';
    const sessionsDir = scoopSessionsDir(folder);
    const result = await snapshotLiveSession({
      vfs,
      cone: { folder, label: 'Research' },
      messages: [user('find the secret token ALPHA-42', 10), assistant('searching…', 20)],
      trigger: 'threshold',
      sessionsDir,
      now: () => 1_000,
    });
    expect(result).not.toBeNull();
    expect(result!.transcriptPath).toMatch(
      new RegExp(`^/scoops/${folder}/sessions/live-research-worker-`)
    );
    expect(result!.transcriptPath.startsWith('/sessions/')).toBe(false);
    expect(vfs.files.has(result!.transcriptPath)).toBe(true);
    expect(vfs.files.has('/sessions/index.json')).toBe(false);
    const archive = parseFrozenArchive(vfs.files.get(result!.transcriptPath)!);
    expect(archive.messages.map((m) => m.content)).toEqual([
      'find the secret token ALPHA-42',
      'searching…',
    ]);
    expect(vfs.files.has(`${sessionsDir}/index.json`)).toBe(true);
  });

  it('keeps the live path stable across rounds so the summary pointer stays resolvable', async () => {
    const vfs = fakeVfs();
    const folder = 'stable-scoop';
    const sessionsDir = scoopSessionsDir(folder);
    const first = await snapshotLiveSession({
      vfs,
      cone: { folder },
      messages: [user('q1', 10), assistant('a1', 20)],
      trigger: 'threshold',
      sessionsDir,
    });
    const second = await snapshotLiveSession({
      vfs,
      cone: { folder },
      messages: [
        user('<context-summary>…</context-summary>', 50),
        user('q1', 10),
        assistant('a1', 20),
        user('q2', 60),
      ],
      trigger: 'threshold',
      sessionsDir,
    });
    expect(second!.transcriptPath).toBe(first!.transcriptPath);
    expect(vfs.files.has(second!.transcriptPath)).toBe(true);
  });

  it('drives a scoop past the compaction threshold: archive + resolving pointer when memory-v2 is on', async () => {
    mocks.enabledFlags.add('memory-v2');
    const vfs = fakeVfs();
    const folder = 'heavy-lifter';
    const sessionsDir = scoopSessionsDir(folder);
    let pointer: string | undefined;

    const onBeforeCompaction = async (
      messages: AgentMessage[],
      trigger: string
    ): Promise<CompactionSnapshot | undefined> => {
      if (!mocks.enabledFlags.has('memory-v2')) return undefined;
      const result = await snapshotLiveSession({
        vfs,
        cone: { folder },
        messages,
        trigger: trigger as 'threshold',
        sessionsDir,
      });
      return result ? { transcriptPath: result.transcriptPath } : undefined;
    };

    const compact = createCompactContext({
      model,
      getApiKey: () => 'key',
      contextWindow: 10_000,
      reserveTokens: 1_000,
      keepRecentTokens: 500,
      onBeforeCompaction: async (messages, trigger) => {
        const snap = await onBeforeCompaction(messages, trigger);
        pointer = snap?.transcriptPath;
        return snap;
      },
    });

    const input = conversation();
    // Pre-compaction content the summary will drop — must survive in the archive.
    input[0] = text('user', 12_000, 1);
    (input[0] as { content: { type: string; text: string }[] }).content[0].text =
      `UNIQUE-PRE-COMPACTION-MARKER ${'x'.repeat(11_970)}`;

    const result = await compact(input);
    expect(pointer).toBeDefined();
    expect(pointer!).toMatch(new RegExp(`^/scoops/${folder}/sessions/live-`));
    expect(vfs.files.has(pointer!)).toBe(true);
    expect(vfs.files.has('/sessions/index.json')).toBe(false);
    const archive = parseFrozenArchive(vfs.files.get(pointer!)!);
    expect(
      archive.messages.some((m) => String(m.content).includes('UNIQUE-PRE-COMPACTION-MARKER'))
    ).toBe(true);
    expect(textOf(result[0])).toContain(`saved at ${pointer}`);
  });

  it('writes nothing when memory-v2 is off', async () => {
    // Flag off: the scoop gate returns before snapshotLiveSession runs.
    const vfs = fakeVfs();
    const folder = 'silent-scoop';
    const onBeforeCompaction = async (): Promise<CompactionSnapshot | undefined> => {
      if (!mocks.enabledFlags.has('memory-v2')) return undefined;
      const result = await snapshotLiveSession({
        vfs,
        cone: { folder },
        messages: conversation(),
        trigger: 'threshold',
        sessionsDir: scoopSessionsDir(folder),
      });
      return result ? { transcriptPath: result.transcriptPath } : undefined;
    };

    const compact = createCompactContext({
      model,
      getApiKey: () => 'key',
      contextWindow: 10_000,
      reserveTokens: 1_000,
      keepRecentTokens: 500,
      onBeforeCompaction,
    });

    await compact(conversation());
    expect(vfs.files.size).toBe(0);
  });

  it('uses a per-sandbox index lock, not the cone /sessions lock', async () => {
    const vfs = fakeVfs();
    const folder = 'locked-scoop';
    const sessionsDir = scoopSessionsDir(folder);
    const held: string[] = [];
    const locks = {
      async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        held.push(name);
        return callback();
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks },
    });
    try {
      await snapshotLiveSession({
        vfs,
        cone: { folder },
        messages: [user('q', 1)],
        trigger: 'threshold',
        sessionsDir,
      });
    } finally {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
    expect(held).toEqual([`slicc:sessions-index:${sessionsDir}`]);
  });
});

describe('scoop snapshot RestrictedFS sandbox boundary', () => {
  let dbCounter = 0;

  it('writes under the scoop sandbox and cannot escape to /sessions or another scoop', async () => {
    const vfs = await VirtualFS.create({
      dbName: `test-scoop-snapshot-sandbox-${dbCounter++}`,
      wipe: true,
    });
    const folder = 'andy-scoop';
    await vfs.mkdir(`/scoops/${folder}`, { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });
    await vfs.mkdir('/sessions', { recursive: true });

    const restricted = new RestrictedFS(vfs, [`/scoops/${folder}/`, '/shared/']);
    const sessionsDir = scoopSessionsDir(folder);

    const result = await snapshotLiveSession({
      vfs: restricted,
      cone: { folder },
      messages: [user('sandbox me', 10), assistant('ok', 20)],
      trigger: 'threshold',
      sessionsDir,
    });
    expect(result).not.toBeNull();
    expect(result!.transcriptPath.startsWith(`/scoops/${folder}/sessions/`)).toBe(true);

    // Readable through the same RestrictedFS (pointer resolves for the scoop).
    const raw = await restricted.readFile(result!.transcriptPath, { encoding: 'utf-8' });
    expect(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)).toContain('sandbox me');

    // Escape attempts: cone /sessions and a sibling scoop are out of grant.
    await expect(restricted.writeFile('/sessions/escape.md', 'nope')).rejects.toThrow(/EACCES/);
    await expect(
      restricted.writeFile('/scoops/other-scoop/sessions/stolen.md', 'nope')
    ).rejects.toThrow(/EACCES/);

    // The snapshot writer never needed the cone index.
    await expect(restricted.readFile('/sessions/index.json')).rejects.toThrow(/ENOENT/);
  });
});
