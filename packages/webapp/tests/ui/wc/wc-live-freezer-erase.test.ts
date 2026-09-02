// @vitest-environment jsdom
/**
 * "Erase" keeps nothing: the clear-chat request carries the intent to the
 * kernel, which deletes the live compaction snapshot inside the snapshot
 * writer's own index transaction. Save and skip leave it to the freezer,
 * which completes it instead.
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

const clearCalls: Array<[string | undefined, { discardLiveSnapshot?: boolean } | undefined]> = [];

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
      clearAllMessages: vi.fn(async (jid?: string, options?: { discardLiveSnapshot?: boolean }) => {
        clearCalls.push([jid, options]);
      }),
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
  it('asks the kernel to discard for erase only, so the delete is ordered with the writer', async () => {
    clearCalls.length = 0;
    const freezer = harness();

    await runNewChat(freezer, 'save');
    await runNewChat(freezer, 'skip');
    expect(clearCalls).toEqual([
      ['cone_2', {}],
      ['cone_2', {}],
    ]);

    await runNewChat(freezer, 'erase');
    expect(clearCalls[2]).toEqual(['cone_2', { discardLiveSnapshot: true }]);
  });
});
