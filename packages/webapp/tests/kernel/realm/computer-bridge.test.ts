/**
 * Realm `sliccy:computer` bridge. Uses the same `attachRealmHost` RPC
 * path as a DedicatedWorker jshd unit (`js-realm-worker` → `runJsRealm`).
 * A Playwright fake-LLM look-click-look against a live tab is not in
 * this suite; `computer-command.test.ts` covers look-click-look on the
 * shell, and `jsh.test.ts` covers cached-frame timeouts.
 */
import type { ComputerCapabilities, ComputerFrame, ComputerInputEvent } from '@slicc/shared-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  getComputerRegistry,
  resetComputerRegistryForTests,
} from '../../../src/computers/registry.js';
import { createComputerBridge } from '../../../src/kernel/realm/realm-computer-bridge.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { makeCtx, makePortPair } from './device-bridge-test-helpers.js';

const CAPABILITIES: ComputerCapabilities = {
  screenshot: true,
  text: true,
  frames: 'poll',
  keyboard: true,
  mouse: 'absolute',
  scroll: false,
  exec: false,
  inputAllowed: true,
};

const FRAME: ComputerFrame = {
  seq: 1,
  mime: 'image/jpeg',
  width: 1,
  height: 1,
  bytes: MINIMAL_JPEG,
};

afterEach(() => {
  resetComputerRegistryForTests();
});

function setup() {
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, makeCtx(), { ppid: 42 });
  const client = new RealmRpcClient(realm);
  const computer = createComputerBridge(client);
  return {
    computer,
    dispose: async () => {
      handle.dispose();
      await Promise.resolve();
      client.dispose();
    },
  };
}

describe('realm computer bridge', () => {
  it('registers a jsh computer and round-trips screenshot, text, and input', async () => {
    const seen: ComputerInputEvent[][] = [];
    const { computer, dispose } = setup();
    const unreg = computer.register({
      id: 'jsh:demo',
      title: 'demo',
      size: { width: 1, height: 1 },
      capabilities: CAPABILITIES,
      screenshot: async () => FRAME,
      text: async () => 'hello',
      input: async (events) => {
        seen.push(events);
      },
    });
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:demo')).toBeTruthy();
    });
    const entry = getComputerRegistry()!.getEntry('jsh:demo')!;
    expect(entry.descriptor).toMatchObject({
      id: 'jsh:demo',
      kind: 'jsh',
      title: 'demo',
      pid: 42,
    });
    expect(await entry.backend.screenshot({ format: 'jpeg' })).toMatchObject({
      mime: 'image/jpeg',
      width: 1,
      height: 1,
    });
    expect(await entry.backend.text?.()).toBe('hello');
    await entry.backend.input([{ type: 'text', text: 'hi' }]);
    expect(seen).toEqual([[{ type: 'text', text: 'hi' }]]);
    unreg();
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:demo')).toBeNull();
    });
    await dispose();
  });

  it('rejects unsupported exec and surfaces handler errors', async () => {
    const { computer, dispose } = setup();
    computer.register({
      id: 'jsh:err',
      capabilities: CAPABILITIES,
      screenshot: async () => {
        throw new Error('capture failed');
      },
      input: async () => {},
    });
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:err')).toBeTruthy();
    });
    const backend = getComputerRegistry()!.get('jsh:err')!;
    await expect(backend.screenshot({ format: 'jpeg' })).rejects.toThrow('capture failed');
    await expect(backend.exec?.('echo hi')).rejects.toThrow('exec is not supported');
    await dispose();
  });

  it('unregisters leftovers when the realm host disposes', async () => {
    const { computer, dispose } = setup();
    computer.register({
      id: 'jsh:leak',
      capabilities: CAPABILITIES,
      screenshot: async () => FRAME,
      input: async () => {},
    });
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:leak')).toBeTruthy();
    });
    await dispose();
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:leak')).toBeNull();
    });
  });

  it('pushes subscribe frames over computer.frame and caches them for screenshot', async () => {
    const shots = vi.fn(async () => FRAME);
    let stopCount = 0;
    const { computer, dispose } = setup();
    const unreg = computer.register({
      id: 'jsh:push',
      capabilities: { ...CAPABILITIES, frames: 'push' },
      screenshot: shots,
      input: async () => {},
      subscribe(_fps, onFrame) {
        onFrame({ ...FRAME, seq: 3 });
        return () => {
          stopCount += 1;
        };
      },
    });
    await vi.waitFor(() => {
      expect(getComputerRegistry()?.get('jsh:push')).toBeTruthy();
    });
    const backend = getComputerRegistry()!.getEntry('jsh:push')!.backend;
    const seen: number[] = [];
    const stop = backend.subscribe?.(2, (frame) => {
      seen.push(frame.seq);
    });
    await vi.waitFor(() => {
      expect(seen).toEqual([3]);
    });
    expect(await backend.screenshot({ format: 'jpeg' })).toMatchObject({ seq: 3 });
    expect(shots).not.toHaveBeenCalled();
    stop?.();
    unreg();
    await vi.waitFor(() => {
      expect(stopCount).toBeGreaterThan(0);
      expect(getComputerRegistry()?.get('jsh:push')).toBeNull();
    });
    await dispose();
  });
});
