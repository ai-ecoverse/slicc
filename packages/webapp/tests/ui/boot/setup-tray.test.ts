// @vitest-environment jsdom
/**
 * Focused tests for the `createLeaderTraySetup()` boot stage. These
 * pin the wiring contract between the boot orchestrator and the
 * leader-tray surfaces:
 *
 *   - `wireLeaderHooks` plumbs the live handle into the chat panel's
 *     local-user-message broadcaster and the sprinkle manager's
 *     send-to-sprinkle hook (both required for follower sync).
 *   - `wireLeaderHooks` registers a connected-followers getter and a
 *     tray-reset hook with the shell `host` command module so the
 *     panel-terminal `host` subcommand can introspect / reset the
 *     live leader.
 *   - `clearLeaderHooks` nulls every hook AND disposes the page-side
 *     remote-CDP bridge sessions so a follower disconnect or
 *     leader-leave doesn't leak federated CDP transports.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getConnectedFollowers,
  getTrayResetter,
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../../../src/shell/supplemental-commands/host-command.js';
import { createLeaderTraySetup } from '../../../src/ui/boot/setup-tray.js';
import type { TraySetupDeps } from '../../../src/ui/boot/types.js';
import type { PageLeaderTrayHandle } from '../../../src/ui/page-leader-tray.js';

function makeFakeDeps(): {
  deps: TraySetupDeps;
  setOnLocalUserMessage: ReturnType<typeof vi.fn>;
  setSendToSprinkleHook: ReturnType<typeof vi.fn>;
  disposeAll: ReturnType<typeof vi.fn>;
} {
  const setOnLocalUserMessage = vi.fn();
  const setSendToSprinkleHook = vi.fn();
  const disposeAll = vi.fn();
  const deps: TraySetupDeps = {
    layout: {
      panels: { chat: { setOnLocalUserMessage } },
    },
    sprinkleManager: { setSendToSprinkleHook },
    remoteCdpBridge: { disposeAll },
  };
  return { deps, setOnLocalUserMessage, setSendToSprinkleHook, disposeAll };
}

function makeFakeHandle(): {
  handle: PageLeaderTrayHandle;
  broadcastSprinkleUpdate: ReturnType<typeof vi.fn>;
  broadcastUserMessage: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  getPeers: ReturnType<typeof vi.fn>;
} {
  const broadcastSprinkleUpdate = vi.fn();
  const broadcastUserMessage = vi.fn();
  const reset = vi.fn(async () => ({ kind: 'inactive' as const }));
  const getPeers = vi.fn(() => [
    { bootstrapId: 'boot-1', runtime: 'slicc-cli' as const, connectedAt: 123 },
  ]);
  const handle = {
    sync: { broadcastSprinkleUpdate, broadcastUserMessage },
    peers: { getPeers },
    reset,
  } as unknown as PageLeaderTrayHandle;
  return { handle, broadcastSprinkleUpdate, broadcastUserMessage, reset, getPeers };
}

afterEach(() => {
  setConnectedFollowersGetter(null);
  setTrayResetter(null);
});

describe('createLeaderTraySetup', () => {
  it('wireLeaderHooks routes chat broadcasts + sprinkle updates through the handle', () => {
    const { deps, setOnLocalUserMessage, setSendToSprinkleHook } = makeFakeDeps();
    const { handle, broadcastUserMessage, broadcastSprinkleUpdate } = makeFakeHandle();

    const { wireLeaderHooks } = createLeaderTraySetup(deps);
    wireLeaderHooks(handle);

    const chatCb = setOnLocalUserMessage.mock.calls[0][0] as (
      text: string,
      id: string,
      atts?: unknown[]
    ) => void;
    chatCb('hello', 'msg-1');
    expect(broadcastUserMessage).toHaveBeenCalledWith('hello', 'msg-1', undefined);

    const sprinkleCb = setSendToSprinkleHook.mock.calls[0][0] as (n: string, d: unknown) => void;
    sprinkleCb('welcome', { action: 'first-run' });
    expect(broadcastSprinkleUpdate).toHaveBeenCalledWith('welcome', { action: 'first-run' });
  });

  it('wireLeaderHooks registers the host-command followers getter + reset hook', async () => {
    const { deps } = makeFakeDeps();
    const { handle, getPeers, reset } = makeFakeHandle();

    const { wireLeaderHooks } = createLeaderTraySetup(deps);
    wireLeaderHooks(handle);

    const peers = getConnectedFollowers();
    expect(getPeers).toHaveBeenCalled();
    expect(peers).toEqual([
      { runtimeId: 'follower-boot-1', runtime: 'slicc-cli', connectedAt: 123 },
    ]);

    const resetter = getTrayResetter();
    expect(resetter).toBeDefined();
    await resetter?.();
    expect(reset).toHaveBeenCalled();
  });

  it('clearLeaderHooks nulls every hook and disposes the remote-CDP bridge', () => {
    const { deps, setOnLocalUserMessage, setSendToSprinkleHook, disposeAll } = makeFakeDeps();
    const { handle } = makeFakeHandle();

    const { wireLeaderHooks, clearLeaderHooks } = createLeaderTraySetup(deps);
    wireLeaderHooks(handle);
    setOnLocalUserMessage.mockClear();
    setSendToSprinkleHook.mockClear();

    clearLeaderHooks();

    expect(setOnLocalUserMessage).toHaveBeenCalledWith(undefined);
    expect(setSendToSprinkleHook).toHaveBeenCalledWith(undefined);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(getConnectedFollowers()).toEqual([]);
    expect(getTrayResetter()).toBeUndefined();
  });
});
