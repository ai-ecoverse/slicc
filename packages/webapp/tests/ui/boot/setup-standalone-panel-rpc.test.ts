import { describe, expect, it, vi } from 'vitest';
import type { ComputerNativeFramePayload } from '../../../src/kernel/panel-rpc.js';
import { createComputerNativeBridge } from '../../../src/ui/boot/setup-standalone-panel-rpc.js';

type CaptureOpts = {
  watch?: boolean;
  display?: number;
  onFrame?: (frame: {
    jpeg: string;
    mime: string;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
  }) => void;
};

function fakeLeader() {
  const captures: CaptureOpts[] = [];
  const unwatched: string[] = [];
  const sync = {
    captureNativeComputer: vi.fn(async (_runtimeId: string, opts: CaptureOpts) => {
      captures.push(opts);
      const frame = {
        jpeg: 'AAA',
        mime: 'image/jpeg',
        width: 4,
        height: 2,
        nativeWidth: 5120,
        nativeHeight: 2880,
      };
      opts.onFrame?.(frame);
      return frame;
    }),
    inputNativeComputer: vi.fn(async () => {}),
    unwatchNativeComputer: vi.fn((runtimeId: string) => {
      unwatched.push(runtimeId);
    }),
  };
  return {
    captures,
    unwatched,
    sync,
    getLeader: () => ({ currentLeaderSync: sync }) as never,
  };
}

describe('createComputerNativeBridge', () => {
  it('pushes every frame of a watch on the frame channel, tagged with the runtime', async () => {
    const leader = fakeLeader();
    const emitted: ComputerNativeFramePayload[] = [];
    const bridge = createComputerNativeBridge(leader.getLeader, (payload) => emitted.push(payload));
    const result = await bridge({
      runtimeId: 'sliccstart-computer-1',
      action: 'capture',
      fps: 10,
      maxWidth: 1536,
      display: 3,
      watch: true,
    });
    expect(result).toMatchObject({ ok: true, jpeg: 'AAA', nativeWidth: 5120 });
    expect(leader.captures[0]).toMatchObject({ watch: true, display: 3 });
    // A later frame of the same stream rides the same sink.
    leader.captures[0].onFrame?.({
      jpeg: 'BBB',
      mime: 'image/jpeg',
      width: 4,
      height: 2,
      nativeWidth: 5120,
      nativeHeight: 2880,
    });
    expect(emitted.map((f) => f.jpeg)).toEqual(['AAA', 'BBB']);
    expect(emitted.every((f) => f.runtimeId === 'sliccstart-computer-1')).toBe(true);
  });

  it('attaches no frame sink to a one-shot capture', async () => {
    const leader = fakeLeader();
    const emitted: ComputerNativeFramePayload[] = [];
    const bridge = createComputerNativeBridge(leader.getLeader, (payload) => emitted.push(payload));
    await bridge({ runtimeId: 'mac', action: 'capture', watch: false });
    expect(leader.captures[0].onFrame).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it('routes unwatch and input, and refuses without a leader tray', async () => {
    const leader = fakeLeader();
    const bridge = createComputerNativeBridge(leader.getLeader, () => {});
    expect(await bridge({ runtimeId: 'mac', action: 'unwatch' })).toEqual({ ok: true });
    expect(leader.unwatched).toEqual(['mac']);
    expect(
      await bridge({ runtimeId: 'mac', action: 'input', events: [{ type: 'key', keysym: 'a' }] })
    ).toEqual({ ok: true });
    expect(leader.sync.inputNativeComputer).toHaveBeenCalled();

    const orphan = createComputerNativeBridge(
      () => null as never,
      () => {}
    );
    await expect(orphan({ runtimeId: 'mac', action: 'unwatch' })).rejects.toThrow(
      'no active leader tray'
    );
  });
});
