// @vitest-environment jsdom
/**
 * "New chat" is per-cone (#2272): the freezer archives and clears the cone
 * the user is looking at, and leaves every other cone alone. A selected
 * scoop resolves to the root that owns it; nothing selected falls back to
 * the default root, which is the pre-multiple-cones behaviour.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const freezeCalls = vi.hoisted(
  () => [] as Array<{ kind: 'save' | 'quick'; cone?: { folder: string; label?: string } }>
);
vi.mock('../../../src/ui/new-session.js', () => ({
  resetNewSessionTmp: vi.fn(async () => undefined),
  runNewSessionFreeze: vi.fn(async (opts: { cone?: { folder: string; label?: string } }) => {
    freezeCalls.push({ kind: 'save', cone: opts.cone });
    return null;
  }),
  runNewSessionFreezeQuick: vi.fn(async (opts: { cone?: { folder: string; label?: string } }) => {
    freezeCalls.push({ kind: 'quick', cone: opts.cone });
    return null;
  }),
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

function unit(over: Partial<RegisteredScoop>): RegisteredScoop {
  return {
    jid: 'jid',
    name: 'name',
    folder: 'folder',
    isCone: over.parentJid === null,
    type: over.parentJid === null ? 'cone' : 'scoop',
    requiresTrigger: false,
    assistantLabel: 'label',
    addedAt: '2026-01-01T00:00:00.000Z',
    parentJid: 'cone_1',
    ...over,
  } as RegisteredScoop;
}

const primary = unit({
  jid: 'cone_1',
  parentJid: null,
  folder: 'cone',
  name: 'Cone',
  assistantLabel: 'sliccy',
});
const research = unit({
  jid: 'cone_2',
  parentJid: null,
  folder: 'cone-research',
  name: 'Research',
  assistantLabel: 'Research',
  addedAt: '2026-01-02T00:00:00.000Z',
});
const helper = unit({ jid: 'scoop_1', parentJid: 'cone_2', folder: 'helper', name: 'helper' });

const ROSTER = [primary, research, helper];

interface Harness {
  freezer: HTMLElement;
  clearCalls: Array<string | undefined>;
  selected: RegisteredScoop | null;
  selections: string[];
  files: Map<string, string>;
  handles: ReturnType<typeof wireFreezerRail>;
}

function harness(selected: RegisteredScoop | null): Harness {
  const files = new Map<string, string>();
  const clearCalls: Array<string | undefined> = [];
  const selections: string[] = [];
  const freezer = document.createElement('slicc-freezer');
  freezer.append(document.createElement('slicc-freezer-new'));
  document.body.append(freezer);

  const reader = {
    readFile: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return text;
    },
    readDir: async () => [],
  };
  const refs = {
    freezer,
    thread: document.createElement('slicc-thread'),
    inputCard: document.createElement('slicc-input-card'),
    switcher: document.createElement('slicc-switcher'),
  };
  const state: Harness = {
    freezer,
    clearCalls,
    selected,
    selections,
    files,
    handles: undefined as unknown as ReturnType<typeof wireFreezerRail>,
  };
  state.handles = wireFreezerRail({
    refs: refs as unknown as Parameters<typeof wireFreezerRail>[0]['refs'],
    openVfs: async () =>
      ({ reader, writer: { writeFile: vi.fn(async () => undefined) } }) as unknown as Awaited<
        ReturnType<Parameters<typeof wireFreezerRail>[0]['openVfs']>
      >,
    client: {
      getScoops: () => ROSTER,
      clearAllMessages: async (jid?: string) => {
        clearCalls.push(jid);
      },
      spawnAgent: vi.fn(),
    } as unknown as OffscreenClient,
    getController: () => ({ loadMessages: vi.fn() }) as never,
    getSelected: () => state.selected,
    selectScoop: (scoop) => {
      state.selected = scoop;
      selections.push(scoop.jid);
    },
    clearSelection: () => {
      state.selected = null;
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  return state;
}

async function runNewChat(state: Harness, action: 'save' | 'skip' | 'erase'): Promise<void> {
  state.freezer.dispatchEvent(new CustomEvent(`new-chat-${action}`));
  await vi.waitFor(() =>
    expect(state.freezer.querySelector('slicc-freezer-new')?.hasAttribute('busy')).toBe(false)
  );
}

describe('New chat targets the selected cone (#2272)', () => {
  it('freezes and clears the selected extra cone, never the primary one', async () => {
    freezeCalls.length = 0;
    const state = harness(research);

    await runNewChat(state, 'save');

    expect(freezeCalls).toEqual([
      { kind: 'save', cone: { folder: 'cone-research', label: 'Research' } },
    ]);
    expect(state.clearCalls).toEqual(['cone_2']);
    // Stays on the cone it just cleared.
    expect(state.selections.at(-1)).toBe('cone_2');
  });

  it('resolves a selected scoop to the cone that owns it', async () => {
    freezeCalls.length = 0;
    const state = harness(helper);

    await runNewChat(state, 'skip');

    expect(freezeCalls).toEqual([
      { kind: 'quick', cone: { folder: 'cone-research', label: 'Research' } },
    ]);
    expect(state.clearCalls).toEqual(['cone_2']);
  });

  it('falls back to the primary cone when nothing is selected', async () => {
    freezeCalls.length = 0;
    const state = harness(null);

    await runNewChat(state, 'save');

    expect(freezeCalls).toEqual([{ kind: 'save', cone: { folder: 'cone', label: 'sliccy' } }]);
    expect(state.clearCalls).toEqual(['cone_1']);
  });

  it('erase clears the selected cone without archiving anything', async () => {
    freezeCalls.length = 0;
    const state = harness(research);

    await runNewChat(state, 'erase');

    expect(freezeCalls).toEqual([]);
    expect(state.clearCalls).toEqual(['cone_2']);
  });
});

describe('thaw fallback follows the archive (#2272)', () => {
  it('lands on the cone an unreadable archive named, not the primary one', async () => {
    const state = harness(null);
    state.selected = null;
    state.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'gone.md',
          title: 'Gone',
          frozenAt: '2026-01-01T00:00:00.000Z',
          messageCount: 4,
          cone: 'cone-research',
        },
      ])
    );

    // The archive file itself is missing, so the thaw throws.
    await state.handles.openFrozen('gone.md');

    expect(state.selected?.jid).toBe('cone_2');
  });

  it('lands on the default root for a legacy archive with no cone field', async () => {
    const state = harness(null);
    state.selected = null;
    state.files.set(
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: 'legacy.md',
          title: 'Legacy',
          frozenAt: '2026-01-01T00:00:00.000Z',
          messageCount: 4,
        },
      ])
    );

    await state.handles.openFrozen('legacy.md');

    expect(state.selected?.jid).toBe('cone_1');
  });
});
