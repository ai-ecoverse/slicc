import type { ComputerDescriptor, ComputerInputEvent } from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import { JshComputerBackend } from '../../../src/computers/adapters/jsh.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';

const DESCRIPTOR: ComputerDescriptor = {
  id: 'jsh:demo',
  kind: 'jsh',
  title: 'demo',
  size: { width: 8, height: 8 },
  state: 'live',
  capabilities: {
    screenshot: true,
    text: true,
    frames: 'poll',
    keyboard: true,
    mouse: 'none',
    scroll: false,
    exec: true,
    inputAllowed: true,
  },
  pid: null,
};

describe('JshComputerBackend', () => {
  it('forwards screenshot, text, input, and exec over the call hook', async () => {
    const call = vi.fn(async (op: string, args: unknown[]) => {
      if (op === 'screenshot') {
        return { seq: 1, mime: 'image/jpeg', width: 8, height: 8, bytes: MINIMAL_JPEG };
      }
      if (op === 'text') return 'grid';
      if (op === 'exec') return { stdout: 'ok', stderr: '', exitCode: 0 };
      return { ok: true };
    });
    const backend = new JshComputerBackend(DESCRIPTOR, call);
    expect(backend.describe().id).toBe('jsh:demo');
    expect(await backend.screenshot({ format: 'jpeg' })).toMatchObject({
      width: 8,
      mime: 'image/jpeg',
    });
    expect(await backend.text()).toBe('grid');
    const events: ComputerInputEvent[] = [{ type: 'wait', ms: 1 }];
    await backend.input(events);
    expect(await backend.exec('uname')).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(call.mock.calls.map((c) => c[0])).toEqual(['screenshot', 'text', 'input', 'exec']);
    expect(call.mock.calls[2][1]).toEqual([events]);
  });

  it('patches the descriptor and treats a non-string text dump as null', async () => {
    const backend = new JshComputerBackend(DESCRIPTOR, async (op) => (op === 'text' ? 12 : null));
    backend.patch({ title: 'renamed', state: 'paused' });
    expect(backend.describe()).toMatchObject({ title: 'renamed', state: 'paused' });
    expect(await backend.text()).toBeNull();
    await backend.close();
  });
});
