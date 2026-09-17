import type { ComputerFrame } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { getComputersStore, resetComputersStoreForTests } from '../../src/ui/computers-store.js';

describe('computers-store', () => {
  it('applies list and frame messages', () => {
    resetComputersStoreForTests();
    const store = getComputersStore();
    store.applyList({
      type: 'computers',
      computers: [
        {
          id: 'v86:vm0',
          kind: 'v86',
          title: 'vm0',
          size: null,
          state: 'live',
          capabilities: {
            screenshot: true,
            text: true,
            frames: 'poll',
            keyboard: true,
            mouse: 'relative',
            scroll: true,
            exec: false,
            inputAllowed: true,
          },
          pid: 1024,
        },
      ],
    });
    expect(store.list()).toHaveLength(1);
    const bytes = new Uint8Array([1, 2, 3]);
    store.applyFrame({
      type: 'computer-frame',
      id: 'v86:vm0',
      seq: 1,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      bytes,
    });
    const frame: ComputerFrame | null = store.lastFrame('v86:vm0');
    expect(frame?.seq).toBe(1);
    expect(frame?.bytes).toEqual(bytes);
  });

  it('sends computer-watch and computer-unwatch through the page sender', () => {
    resetComputersStoreForTests();
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string; fps?: number }> = [];
    store.setSender((msg) => sent.push(msg));
    store.watch('tab:T1', 4, 768);
    expect(store.isWatching('tab:T1')).toBe(true);
    expect(sent).toEqual([{ type: 'computer-watch', id: 'tab:T1', fps: 4, maxWidth: 768 }]);
    store.unwatch('tab:T1');
    expect(store.isWatching('tab:T1')).toBe(false);
    expect(sent[1]).toEqual({ type: 'computer-unwatch', id: 'tab:T1' });
  });

  it('refcounts watch so a second subscriber does not unwatch the first', () => {
    resetComputersStoreForTests();
    const store = getComputersStore();
    const sent: Array<{ type: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.watch('jsh:fake');
    store.watch('jsh:fake');
    expect(store.watchRefCount('jsh:fake')).toBe(2);
    expect(sent.filter((m) => m.type === 'computer-watch')).toHaveLength(1);
    store.unwatch('jsh:fake');
    expect(store.isWatching('jsh:fake')).toBe(true);
    expect(sent.filter((m) => m.type === 'computer-unwatch')).toHaveLength(0);
    store.unwatch('jsh:fake');
    expect(store.isWatching('jsh:fake')).toBe(false);
    expect(sent.filter((m) => m.type === 'computer-unwatch')).toHaveLength(1);
  });

  it('records the newest invocation per computer and sends input events', () => {
    resetComputersStoreForTests();
    const store = getComputersStore();
    const sent: Array<{ type: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.recordInvocation('jsh:fake', 'call-1');
    store.recordInvocation('jsh:fake', 'call-2');
    expect(store.newestInvocation('jsh:fake')).toBe('call-2');
    store.input('jsh:fake', [{ type: 'key', keysym: 'Return' }]);
    expect(sent).toEqual([
      { type: 'computer-input', id: 'jsh:fake', events: [{ type: 'key', keysym: 'Return' }] },
    ]);
  });
});
