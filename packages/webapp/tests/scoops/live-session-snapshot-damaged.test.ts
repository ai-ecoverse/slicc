/**
 * #4154: a live snapshot cut off mid-write (a reload killed the worker)
 * parses to no messages. The next compaction round rewrites the file from
 * the agent's current history; before this fix the earlier rounds' bytes
 * were gone for good. Now they ride INSIDE the rewritten archive, so every
 * path that removes or moves the archive takes them along: Erase, the
 * frozen-session delete, and the enrichment rename (after a "New chat"
 * freeze or after a bare clear-chat finalize). No path may leave them on
 * disk once the chat is gone.
 *
 * Runs over a real VirtualFS so the "nothing left on disk" checks walk every
 * file the store holds.
 */
import 'fake-indexeddb/auto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunOneOffCompactionCall = vi.fn();
vi.mock('../../src/core/context-compaction.js', () => ({
  COMPACTION_MEMORY_INSTRUCTION: 'MEMORY',
  COMPACTION_TITLE_INSTRUCTION: 'TITLE',
  runOneOffCompactionCall: (...args: unknown[]) => mockRunOneOffCompactionCall(...args),
}));

import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { WritableVfsClient } from '../../src/kernel/writable-vfs-client.js';
import type { SessionStore } from '../../src/scoops/chat-session-store.js';
import {
  discardLiveSnapshot,
  finalizeLiveSnapshot,
  snapshotLiveSession,
} from '../../src/scoops/live-session-snapshot.js';
import {
  parseFrozenArchive,
  readDamagedSnapshots,
  readSessionsIndex,
} from '../../src/transcript/frozen-archive-format.js';
import { deleteFrozenSession } from '../../src/ui/frozen-session-delete.js';
import { enrichPendingSession, freezeConeSession } from '../../src/ui/session-freezer.js';
import type { Session } from '../../src/ui/types.js';

/** Only ever in the round-one answer: its presence on disk means those bytes are. */
const MARKER = 'ROUND-ONE-ONLY-7f3a';

let dbCounter = 0;
let vfs: VirtualFS;
const page = (): WritableVfsClient => vfs as unknown as WritableVfsClient;
const utf8 = { encoding: 'utf-8' } as const;

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `live-snapshot-damaged-${dbCounter++}`, wipe: true });
  mockRunOneOffCompactionCall.mockReset();
  mockRunOneOffCompactionCall.mockImplementation(async (call?: { instruction?: string }) =>
    call?.instruction === 'MEMORY' ? 'NONE' : 'Recovered Rounds'
  );
});

const agentText = (role: 'user' | 'assistant', text: string, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }) as AgentMessage;

async function round(messages: AgentMessage[]) {
  const result = await snapshotLiveSession({
    vfs,
    cone: { folder: 'cone', label: 'sliccy' },
    messages,
    trigger: 'threshold',
  });
  if (!result) throw new Error('snapshot was skipped');
  return result;
}

async function read(path: string): Promise<string> {
  return (await vfs.readFile(path, utf8)) as string;
}

/** Every file in the store whose bytes still hold the round-one answer. */
async function filesHoldingMarker(): Promise<string[]> {
  const hits: string[] = [];
  for await (const path of vfs.walk('/')) {
    const stat = await vfs.stat(path);
    if (stat.type === 'file' && (await read(path)).includes(MARKER)) hits.push(path);
  }
  return hits;
}

/**
 * Round one, cut off inside its data block (after the round-one answer),
 * then round two over the agent's post-reload history. Returns the cut bytes
 * and the live archive path.
 */
async function damagedThenRewritten(): Promise<{ cut: string; path: string }> {
  const first = await round([
    agentText('user', 'first question', 1),
    agentText('assistant', `first answer ${MARKER}`, 2),
  ]);
  const whole = await read(first.transcriptPath);
  const cut = whole.slice(0, whole.indexOf(MARKER) + MARKER.length + 3);
  await vfs.writeFile(first.transcriptPath, cut);

  await round([agentText('user', 'after the reload', 10), agentText('assistant', 'ok', 11)]);
  return { cut, path: first.transcriptPath };
}

/** The UI store's chat a freeze writes: long enough to freeze, no round-one answer. */
const session: Session = {
  id: 'session-cone',
  createdAt: 10,
  updatedAt: 13,
  messages: [
    { id: 'u10', role: 'user', content: 'after the reload', timestamp: 10 },
    { id: 'a11', role: 'assistant', content: 'ok', timestamp: 11 },
    { id: 'u12', role: 'user', content: 'and then', timestamp: 12 },
    { id: 'a13', role: 'assistant', content: 'done', timestamp: 13 },
  ],
};
const store = {
  async load() {
    return session;
  },
} as unknown as SessionStore;

const enrichOptions = {
  model: { id: 'm', provider: 'anthropic' } as never,
  apiKey: 'k',
  skipMemory: true,
  pickIcon: async () => null,
};

describe('a compaction round over a cut-off live snapshot', () => {
  it('keeps the cut bytes inside the rewritten archive', async () => {
    const { cut, path } = await damagedThenRewritten();

    const markdown = await read(path);
    expect(readDamagedSnapshots(markdown)).toEqual([cut]);
    expect(parseFrozenArchive(markdown).messages.map((m) => m.content)).toEqual([
      'after the reload',
      'ok',
    ]);
    expect(await filesHoldingMarker()).toEqual([path]);
  });

  it('carries them through later healthy rounds', async () => {
    const { cut, path } = await damagedThenRewritten();
    await round([agentText('user', 'third', 20)]);

    const markdown = await read(path);
    expect(readDamagedSnapshots(markdown)).toEqual([cut]);
    expect(parseFrozenArchive(markdown).messages.map((m) => m.content)).toEqual([
      'after the reload',
      'ok',
      'third',
    ]);
  });

  it('does not turn a message that quotes a block into a block, round after round', async () => {
    const quoted = '<!-- slicc:damaged-snapshot\n"hello"\n-->\n\n';
    let path = '';
    for (let i = 1; i <= 4; i += 1) {
      const result = await round([agentText('user', `cat says:\n\n${quoted}`, i)]);
      path = result.transcriptPath;
      expect(readDamagedSnapshots(await read(path))).toEqual([]);
    }
    expect(parseFrozenArchive(await read(path)).messages).toHaveLength(4);
  });

  it('writes no block when the archive is intact', async () => {
    const first = await round([agentText('user', 'q', 1)]);
    await round([agentText('user', 'q2', 2)]);

    expect(readDamagedSnapshots(await read(first.transcriptPath))).toEqual([]);
  });
});

describe('every path that removes or moves the archive takes the kept bytes with it', () => {
  it('Erase: discarding the live snapshot leaves them nowhere', async () => {
    const { path } = await damagedThenRewritten();
    expect(await filesHoldingMarker()).toEqual([path]);

    expect(await discardLiveSnapshot(vfs, 'cone')).toBe(1);

    expect(await filesHoldingMarker()).toEqual([]);
  });

  it('"New chat" freeze + enrichment rename: they move to the renamed archive only', async () => {
    const { cut, path } = await damagedThenRewritten();

    const frozen = await freezeConeSession({ sessionStore: store, vfs: page(), mode: 'quick' });
    expect(frozen?.filename).toBe(path.slice('/sessions/'.length));
    // The freeze replaced the file with the UI store's chat and kept the bytes.
    expect(readDamagedSnapshots(await read(path))).toEqual([cut]);

    const renamed = await enrichPendingSession(page(), frozen!, enrichOptions);
    expect(renamed?.filename).toMatch(/-recovered-rounds\.md$/);

    const renamedPath = `/sessions/${renamed!.filename}`;
    expect(await filesHoldingMarker()).toEqual([renamedPath]);
    expect(readDamagedSnapshots(await read(renamedPath))).toHaveLength(1);
  });

  it('a freeze over a snapshot that is still cut off keeps the cut file', async () => {
    const first = await round([
      agentText('user', 'first question', 1),
      agentText('assistant', `first answer ${MARKER}`, 2),
    ]);
    const whole = await read(first.transcriptPath);
    const cut = whole.slice(0, whole.indexOf(MARKER) + MARKER.length + 3);
    await vfs.writeFile(first.transcriptPath, cut);

    await freezeConeSession({ sessionStore: store, vfs: page(), mode: 'quick' });

    expect(readDamagedSnapshots(await read(first.transcriptPath))).toEqual([cut]);
  });

  it('bare clear-chat finalize + boot enrichment rename: they move to the renamed archive only', async () => {
    await damagedThenRewritten();
    expect(await finalizeLiveSnapshot(vfs, 'cone')).toBe(true);
    const [draft] = await readSessionsIndex(vfs as never);

    const renamed = await enrichPendingSession(page(), draft, enrichOptions);

    expect(await filesHoldingMarker()).toEqual([`/sessions/${renamed!.filename}`]);
  });

  it('frozen-session delete: deleting the renamed chat leaves them nowhere', async () => {
    await damagedThenRewritten();
    const frozen = await freezeConeSession({ sessionStore: store, vfs: page(), mode: 'quick' });
    const renamed = await enrichPendingSession(page(), frozen!, enrichOptions);
    expect(await filesHoldingMarker()).toEqual([`/sessions/${renamed!.filename}`]);

    const result = await deleteFrozenSession(page(), { filename: renamed!.filename });

    expect(result).toEqual({ status: 'deleted' });
    expect(await filesHoldingMarker()).toEqual([]);
  });
});
