// @vitest-environment jsdom
/**
 * Where an inline dip's lick goes.
 *
 * A dip is rendered into ONE unit's transcript, so its buttons belong to that
 * unit's conversation. The lick used to carry no origin at all, and the kernel's
 * untargeted fallback is the OLDEST root: with a second cone open, clicking a
 * card the newer cone had just written sent the lick to the older cone, which
 * had never seen the dip (and saw it twice when the user re-clicked a button
 * that appeared to do nothing).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

/** Captures the `onLick` the controller hands each rendered message. */
const dipHydration: { lastOnLick: ((action: string, data: unknown) => void) | null } = {
  lastOnLick: null,
};

vi.mock('../../../src/ui/dip.js', () => ({
  disposeDips: () => undefined,
  hydrateDips: (_host: HTMLElement, onLick: (action: string, data: unknown) => void) => {
    dipHydration.lastOnLick = onLick;
    return [];
  },
  mountDip: () => ({ dispose: () => undefined }),
}));

import type { ChatMessage } from '../../../src/ui/types.js';
import { attachWcChat } from '../../../src/ui/wc/wc-chat.js';
import type { WcChatHost } from '../../../src/ui/wc/wc-chat-host.js';
import { prepareWcShell } from '../../../src/ui/wc/wc-live.js';
import type {
  Unsubscribe,
  WorkUnitClient,
  WorkUnitSnapshot,
  WorkUnitSummary,
} from '../../../src/work-unit/client/types.js';

function unit(over: Partial<WorkUnitSummary> & { id: string }): WorkUnitSummary {
  return {
    assistantLabel: 'sliccy',
    fill: 0,
    folder: 'cone',
    name: 'sliccy',
    parentId: null,
    role: 'primary',
    state: 'idle',
    ...over,
  };
}

const OLDEST = unit({ id: 'cone-1' });
const NEWER = unit({ id: 'cone-2', folder: 'cone-landlording', name: 'landlording' });

/** One rendered assistant message — enough for the dip pipeline to run. */
const DIP_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: '```shtml\n<button data-action="go">Go</button>\n```',
  timestamp: Date.now(),
};

/**
 * A client whose `subscribe` replays the transcript immediately, which is what
 * the shell renders from (the snapshot request is the ASK; the subscription is
 * the answer — see `createUnitWatcher`).
 */
function fakeClient(): WorkUnitClient {
  const units = [OLDEST, NEWER];
  const snapshot = { messages: [DIP_MESSAGE] } as unknown as WorkUnitSnapshot;
  return {
    currentUnits: () => units,
    list: () => Promise.resolve(units),
    send: () => Promise.resolve(),
    setModel: () => Promise.resolve(true),
    signal: () => Promise.resolve(),
    snapshot: () => Promise.resolve(snapshot),
    subscribe: (_id, listener): Unsubscribe => {
      listener({ type: 'snapshot', snapshot } as never);
      return () => undefined;
    },
    subscribeList: (listener): Unsubscribe => {
      listener(units);
      return () => undefined;
    },
  };
}

/** Mount the shared chat surface, select `unitId`, and render its transcript. */
async function mountAndSelect(unitId: string, host: WcChatHost) {
  const app = document.createElement('div');
  document.body.append(app);
  const boot = prepareWcShell(app, 'test');
  attachWcChat(boot, fakeClient(), host);
  boot.refs.switcher.dispatchEvent(
    new CustomEvent('slicc-scoop-select', { detail: { key: unitId } })
  );
  // The snapshot is a promise; the render (and with it the hydration) lands on
  // its microtask.
  await Promise.resolve();
  await Promise.resolve();
  return boot;
}

function testHost(sendSprinkleLick: WcChatHost['sendSprinkleLick']): WcChatHost {
  return {
    deleteQueuedMessage: () => Promise.resolve(),
    emitAgentError: () => undefined,
    onAgentEvent: () => () => undefined,
    sendSprinkleLick,
    sendToolUiAction: () => undefined,
  };
}

describe('inline dip lick routing', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    dipHydration.lastOnLick = null;
  });

  it('stamps the unit whose transcript rendered the dip', async () => {
    const sent = vi.fn();
    await mountAndSelect('cone-2', testHost(sent));
    expect(dipHydration.lastOnLick).toBeTypeOf('function');

    dipHydration.lastOnLick?.('go', { v: 1 });
    expect(sent).toHaveBeenCalledWith(
      'inline',
      { action: 'go', data: { v: 1 } },
      undefined,
      'cone-2'
    );
  });

  it('keeps the render-time unit when the selection has moved on', async () => {
    // The lick must not follow a later selection into a cone that never wrote
    // the card: the dip belongs to the transcript it was rendered into.
    const sent = vi.fn();
    const boot = await mountAndSelect('cone-2', testHost(sent));
    const licked = dipHydration.lastOnLick;
    boot.refs.switcher.dispatchEvent(
      new CustomEvent('slicc-scoop-select', { detail: { key: 'cone-1' } })
    );
    licked?.('go', null);
    expect(sent).toHaveBeenCalledWith('inline', { action: 'go', data: null }, undefined, 'cone-2');
  });
});
