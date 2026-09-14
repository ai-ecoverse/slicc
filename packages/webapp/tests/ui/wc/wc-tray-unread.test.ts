// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { buildFollowerOptions } from '../../../src/ui/wc/wc-tray.js';

function mountFollower(): {
  switcher: HTMLElement & { scoops: Array<{ key: string; unread?: number }> };
  onScoopsList: (scoops: unknown[], selected?: string) => void;
} {
  const switcher = document.createElement('div') as unknown as HTMLElement & {
    scoops: Array<{ key: string; unread?: number }>;
  };
  const { options } = buildFollowerOptions(
    {
      refs: {
        composerMeta: document.createElement('div'),
        switcher,
        composer: document.createElement('div'),
        inputCard: document.createElement('div'),
        dock: document.createElement('div'),
        overlaySurfaces: new Set(),
      },
      browser: {},
      client: { sendSetFollowerForwarding: vi.fn() },
      window: { localStorage: { getItem: vi.fn(() => null) } },
      getController: () => null,
      addSprinkle: vi.fn(),
      removeSprinkle: vi.fn(),
      agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
      restoreLocalChrome: vi.fn(),
    } as never,
    'https://tray.example/join/token',
    () => ({ selectScoop: vi.fn() }) as never
  );
  return {
    switcher,
    onScoopsList: (scoops, selected) => options.onScoopsList?.(scoops as never, selected as never),
  };
}

const CONE = { jid: 'cone-a', name: 'cone', isCone: true, parentId: null };

const roster = (state: 'working' | 'idle', turns?: number) => [
  CONE,
  {
    jid: 'cone-b',
    name: 'cone',
    isCone: true,
    parentId: null,
    state,
    ...(turns === undefined ? {} : { turns }),
  },
  {
    jid: 'scoop-a',
    name: 'helper',
    isCone: false,
    parentId: 'cone-b',
    state,
    ...(turns === undefined ? {} : { turns }),
  },
];

describe('follower strip unread', () => {
  it('dots a followed cone whose turn ended off-screen, and clears it on selection', () => {
    const { switcher, onScoopsList } = mountFollower();
    const unreadOf = (key: string): number | undefined =>
      switcher.scoops.find((chip) => chip.key === key)?.unread;

    onScoopsList(roster('working'), 'cone-a');
    expect(unreadOf('cone-b')).toBeUndefined();
    onScoopsList(roster('idle'), 'cone-a');
    expect(unreadOf('cone-b')).toBe(1);

    switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-b' }, bubbles: true })
    );
    expect(unreadOf('cone-b')).toBeUndefined();
  });

  it("never dots a scoop, whose turns are its cone's work", () => {
    const { switcher, onScoopsList } = mountFollower();
    onScoopsList(roster('working'), 'cone-a');
    onScoopsList(roster('idle'), 'cone-a');
    expect(switcher.scoops.find((chip) => chip.key === 'scoop-a')?.unread).toBeUndefined();
  });

  it('dots a turn the coalescing window swallowed, seen only as a bumped counter', () => {
    const { switcher, onScoopsList } = mountFollower();
    const unreadOf = (key: string): number | undefined =>
      switcher.scoops.find((chip) => chip.key === key)?.unread;

    onScoopsList(roster('idle', 3), 'cone-a');
    expect(unreadOf('cone-b')).toBeUndefined();

    onScoopsList(roster('idle', 4), 'cone-a');
    expect(unreadOf('cone-b')).toBe(1);
  });

  it('opens a first roster with nothing unread', () => {
    const { switcher, onScoopsList } = mountFollower();
    onScoopsList(roster('idle'), 'cone-a');
    expect(switcher.scoops.every((chip) => chip.unread === undefined)).toBe(true);
  });
});
