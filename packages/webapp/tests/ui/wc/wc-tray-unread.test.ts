// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

// `buildFollowerOptions` touches the composer chrome, which pulls the component
// library into this module graph.
installWcDomStubs();

import { buildFollowerOptions } from '../../../src/ui/wc/wc-tray.js';

/**
 * Follower parity for the strip's unread dot. The leader counts the same thing
 * in `wc-live.test.ts`; both go through `UnreadLedger`, which reads what a
 * roster push carries — the presentation state, and the leader's completed-turn
 * counter where it is present.
 *
 * The counter is what makes the follower's answer complete rather than
 * best-effort: `scoops.list` is coalesced for 50ms, so a turn that opens and
 * closes inside one window is delivered in its final state alone (#2948).
 */
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
    jid: 'scoop-a',
    name: 'helper',
    isCone: false,
    parentId: 'cone-a',
    state,
    ...(turns === undefined ? {} : { turns }),
  },
];

describe('follower strip unread', () => {
  it('dots a followed scoop whose turn ended off-screen, and clears it on selection', () => {
    const { switcher, onScoopsList } = mountFollower();
    const unreadOf = (key: string): number | undefined =>
      switcher.scoops.find((chip) => chip.key === key)?.unread;

    onScoopsList(roster('working'), 'cone-a');
    expect(unreadOf('scoop-a')).toBeUndefined();
    onScoopsList(roster('idle'), 'cone-a');
    expect(unreadOf('scoop-a')).toBe(1);
    // Opening the tab is the read receipt here as well — the follower's own
    // click, which republishes the strip for the new selection.
    switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'scoop-a' }, bubbles: true })
    );
    expect(unreadOf('scoop-a')).toBeUndefined();
  });

  it('dots a turn the coalescing window swallowed, seen only as a bumped counter', () => {
    const { switcher, onScoopsList } = mountFollower();
    const unreadOf = (key: string): number | undefined =>
      switcher.scoops.find((chip) => chip.key === key)?.unread;

    onScoopsList(roster('idle', 3), 'cone-a');
    expect(unreadOf('scoop-a')).toBeUndefined();
    // The leader ran a whole turn between these two frames. State says `idle`
    // both times; the counter is the only thing that says a turn ended.
    onScoopsList(roster('idle', 4), 'cone-a');
    expect(unreadOf('scoop-a')).toBe(1);
  });

  it('opens a first roster with nothing unread', () => {
    const { switcher, onScoopsList } = mountFollower();
    onScoopsList(roster('idle'), 'cone-a');
    expect(switcher.scoops.every((chip) => chip.unread === undefined)).toBe(true);
  });
});
