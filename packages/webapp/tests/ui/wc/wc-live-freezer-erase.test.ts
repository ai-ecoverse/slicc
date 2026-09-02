// @vitest-environment jsdom
/**
 * "Erase" keeps nothing: the live compaction snapshot the session wrote to
 * `/sessions` is discarded for the cone being cleared, and only then. Save
 * and skip leave it to the freezer, which completes it instead.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

vi.mock('../../../src/ui/new-session.js', () => ({
  resetNewSessionTmp: vi.fn(async () => undefined),
  runNewSessionFreeze: vi.fn(async () => null),
  runNewSessionFreezeQuick: vi.fn(async () => null),
  runNewSessionArchiveOnly: vi.fn(async () => null),
}));
const discardCalls = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('../../../src/ui/session-freezer.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discardLiveConeSnapshot: vi.fn(async (_vfs: unknown, folder: string | undefined) => {
      discardCalls.push(folder);
    }),
  };
});
vi.mock('../../../src/transcript/export-provider.js', () => ({
  getTranscriptExportService: () => ({ captureFrozen: vi.fn(async () => undefined) }),
}));
vi.mock('../../../src/speech/dictation-priming.js', () => ({
  resetDictationPriming: vi.fn(),
}));

import type { RegisteredScoop } from '../../../src/scoops/types.js';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import { wireFreezerRail } from '../../../src/ui/wc/wc-live-freezer.js';

const research = {
  jid: 'cone_2',
  name: 'Research',
  folder: 'cone-research',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
  parentJid: null,
} as unknown as RegisteredScoop;

function harness() {
  const freezer = document.createElement('slicc-freezer');
  freezer.append(document.createElement('slicc-freezer-new'));
  document.body.append(freezer);
  const reader = {
    readFile: async (path: string) => {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    },
    readDir: async () => [],
  };
  const refs = {
    freezer,
    thread: document.createElement('slicc-thread'),
    inputCard: document.createElement('slicc-input-card'),
    switcher: document.createElement('slicc-switcher'),
  };
  wireFreezerRail({
    refs: refs as unknown as Parameters<typeof wireFreezerRail>[0]['refs'],
    openVfs: async () =>
      ({ reader, writer: { writeFile: vi.fn(async () => undefined) } }) as unknown as Awaited<
        ReturnType<Parameters<typeof wireFreezerRail>[0]['openVfs']>
      >,
    client: {
      getScoops: () => [research],
      clearAllMessages: vi.fn(async () => undefined),
      spawnAgent: vi.fn(),
    } as unknown as OffscreenClient,
    getController: () => ({ loadMessages: vi.fn() }) as never,
    getSelected: () => research,
    selectScoop: vi.fn(),
    clearSelection: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  return freezer;
}

async function runNewChat(freezer: HTMLElement, action: 'save' | 'skip' | 'erase'): Promise<void> {
  freezer.dispatchEvent(new CustomEvent(`new-chat-${action}`));
  await vi.waitFor(() =>
    expect(freezer.querySelector('slicc-freezer-new')?.hasAttribute('busy')).toBe(false)
  );
}

describe('New chat → erase discards the live snapshot', () => {
  it('discards for the cone being erased and for no other action', async () => {
    discardCalls.length = 0;
    const freezer = harness();

    await runNewChat(freezer, 'save');
    await runNewChat(freezer, 'skip');
    expect(discardCalls).toEqual([]);

    await runNewChat(freezer, 'erase');
    expect(discardCalls).toEqual(['cone-research']);
  });
});
