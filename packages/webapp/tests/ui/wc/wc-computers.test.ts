// @vitest-environment jsdom
/**
 * Overlay merge, lightbox watch lifecycle, and bash-row live/frozen wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import '@slicc/webcomponents';
import type { ComputerDescriptor } from '@slicc/shared-ts';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import { getComputersStore, resetComputersStoreForTests } from '../../../src/ui/computers-store.js';
import {
  bindComputerOverlay,
  computerOverlayId,
  disposeWcComputersForTests,
  installWcComputers,
  mergeOverlayTabs,
  parseComputerIdFromCommand,
  parseFrozenFrameHint,
} from '../../../src/ui/wc/wc-computers.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function descriptor(
  id = 'jsh:fake',
  state: ComputerDescriptor['state'] = 'live'
): ComputerDescriptor {
  return {
    id,
    kind: 'jsh',
    title: id,
    size: { width: 8, height: 8 },
    state,
    capabilities: {
      screenshot: true,
      text: false,
      frames: 'poll',
      keyboard: true,
      mouse: 'absolute',
      scroll: true,
      exec: false,
      inputAllowed: true,
    },
    pid: null,
    softKeys: [{ label: 'Enter', keysym: 'Return' }],
  };
}

function applyFrame(id: string, seq = 1): void {
  getComputersStore().applyFrame({
    type: 'computer-frame',
    id,
    seq,
    mime: 'image/jpeg',
    width: 8,
    height: 8,
    bytes: MINIMAL_JPEG,
  });
}

describe('wc-computers helpers', () => {
  it('parses -c / --computer and frozen screen / img hints', () => {
    expect(parseComputerIdFromCommand('computer -c jsh:fake screenshot')).toBe('jsh:fake');
    expect(parseComputerIdFromCommand('computer --computer tab:T1 key Return')).toBe('tab:T1');
    expect(parseComputerIdFromCommand('ls')).toBeNull();
    expect(parseFrozenFrameHint('ok\nscreen: /tmp/computer/fake/1.jpg\n')).toEqual({
      kind: 'path',
      path: '/tmp/computer/fake/1.jpg',
    });
    expect(parseFrozenFrameHint('<img:data:image/jpeg;base64,QUJD>')).toEqual({
      kind: 'data',
      src: 'data:image/jpeg;base64,QUJD',
    });
    expect(parseFrozenFrameHint('no frame')).toBeNull();
  });

  it('merges computer cards after browser tabs with kind/live/softKeys', () => {
    resetComputersStoreForTests();
    const store = getComputersStore();
    store.applyList({ type: 'computers', computers: [descriptor()] });
    store.applyFrame({
      type: 'computer-frame',
      id: 'jsh:fake',
      seq: 1,
      mime: 'image/jpeg',
      width: 8,
      height: 8,
      bytes: MINIMAL_JPEG,
    });
    const tabs = mergeOverlayTabs([
      { id: 'tab-1', title: 'Docs', url: 'https://docs.example' },
      { id: 'computer:stale', kind: 'computer', title: 'gone' },
    ]);
    expect(tabs.map((t) => t.id)).toEqual(['tab-1', 'computer:jsh:fake']);
    expect(tabs[1]).toMatchObject({
      kind: 'computer',
      live: true,
      title: 'jsh:fake',
      softKeys: [{ label: 'Enter', keysym: 'Return' }],
    });
    expect(tabs[1]?.screenshot?.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('wc-computers wiring', () => {
  beforeEach(() => {
    resetComputersStoreForTests();
    disposeWcComputersForTests();
    document.body.replaceChildren();
  });

  afterEach(() => {
    disposeWcComputersForTests();
    resetComputersStoreForTests();
  });

  it('watches on lightbox open and unwatches on close', () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake');
    installWcComputers({ log });
    const overlay = document.createElement('slicc-tab-overlay') as HTMLElement & {
      tabs: ReturnType<typeof mergeOverlayTabs>;
    };
    document.body.append(overlay);
    overlay.tabs = mergeOverlayTabs([]);
    bindComputerOverlay(overlay, log);

    overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: computerOverlayId('jsh:fake') } })
    );
    expect(sent).toEqual([{ type: 'computer-watch', id: 'jsh:fake', fps: 4, maxWidth: 768 }]);
    const preview = document.querySelector('slicc-image-preview');
    expect(preview?.hasAttribute('open')).toBe(true);

    preview?.dispatchEvent(new CustomEvent('slicc-image-preview-close', { bubbles: true }));
    expect(sent[1]).toEqual({ type: 'computer-unwatch', id: 'jsh:fake' });
    expect(store.isWatching('jsh:fake')).toBe(false);
  });

  it('watches registered computers while the overlay is open', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string; fps?: number; maxWidth?: number }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    installWcComputers({ log });
    const overlay = document.createElement('slicc-tab-overlay') as HTMLElement & {
      tabs: ReturnType<typeof mergeOverlayTabs>;
    };
    document.body.append(overlay);
    bindComputerOverlay(overlay, log);
    expect(sent).toEqual([]);
    overlay.setAttribute('open', '');
    await vi.waitFor(() =>
      expect(sent).toEqual([{ type: 'computer-watch', id: 'jsh:fake', fps: 2, maxWidth: 480 }])
    );
    expect(store.isWatching('jsh:fake')).toBe(true);
    overlay.removeAttribute('open');
    await vi.waitFor(() => expect(sent[1]).toEqual({ type: 'computer-unwatch', id: 'jsh:fake' }));
    expect(store.isWatching('jsh:fake')).toBe(false);
  });

  it('upgrades overlay 2 fps/480 to lightbox 4 fps/768 without dropping the overlay watch', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string; fps?: number; maxWidth?: number }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake');
    installWcComputers({ log });
    const overlay = document.createElement('slicc-tab-overlay') as HTMLElement & {
      tabs: ReturnType<typeof mergeOverlayTabs>;
    };
    document.body.append(overlay);
    bindComputerOverlay(overlay, log);
    overlay.setAttribute('open', '');
    await vi.waitFor(() =>
      expect(sent).toEqual([{ type: 'computer-watch', id: 'jsh:fake', fps: 2, maxWidth: 480 }])
    );

    overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: computerOverlayId('jsh:fake') } })
    );
    expect(sent[1]).toEqual({ type: 'computer-watch', id: 'jsh:fake', fps: 4, maxWidth: 768 });
    expect(store.watchRefCount('jsh:fake')).toBe(2);

    overlay.removeAttribute('open');
    await vi.waitFor(() => expect(store.watchRefCount('jsh:fake')).toBe(1));
    expect(sent.filter((m) => m.type === 'computer-unwatch')).toHaveLength(0);
    expect(store.isWatching('jsh:fake')).toBe(true);
  });

  it('softkeys dispatch computer-input via the store', () => {
    const store = getComputersStore();
    const sent: Array<{ type: string }> = [];
    store.setSender((msg) => sent.push(msg));
    const overlay = document.createElement('slicc-tab-overlay');
    document.body.append(overlay);
    bindComputerOverlay(overlay, log);
    overlay.dispatchEvent(
      new CustomEvent('computer-softkey', {
        detail: { id: computerOverlayId('jsh:fake'), keysym: 'Return', label: 'Enter' },
      })
    );
    expect(sent).toEqual([
      { type: 'computer-input', id: 'jsh:fake', events: [{ type: 'key', keysym: 'Return' }] },
    ]);
  });

  it('binds a live row for the newest call and freezes it when superseded or disconnected', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake');
    installWcComputers({ log });

    const first = document.createElement('slicc-bash-renderer-computer');
    first.command = 'computer -c jsh:fake screenshot';
    first.toolCallId = 'call-1';
    first.output = 'screen: /tmp/a.jpg';
    document.body.append(first);
    await vi.waitFor(() => expect(first.frameMode).toBe('live'));
    expect(store.isWatching('jsh:fake')).toBe(true);

    const second = document.createElement('slicc-bash-renderer-computer');
    second.command = 'computer -c jsh:fake key Return';
    second.toolCallId = 'call-2';
    second.output = 'screen: /tmp/b.jpg';
    document.body.append(second);
    await vi.waitFor(() => expect(second.frameMode).toBe('live'));
    await vi.waitFor(() => expect(first.frameMode).toBe('frozen'));
    expect(store.watchRefCount('jsh:fake')).toBe(1);

    store.applyList({ type: 'computers', computers: [descriptor('jsh:fake', 'gone')] });
    await vi.waitFor(() => expect(second.frameMode).toBe('frozen'));
    expect(store.isWatching('jsh:fake')).toBe(false);

    first.remove();
    second.remove();
    expect(store.isWatching('jsh:fake')).toBe(false);
  });

  it('keeps a frozen still until a pushed frame arrives, then shows LIVE', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    installWcComputers({ log });

    const el = document.createElement('slicc-bash-renderer-computer');
    el.command = 'computer -c jsh:fake screenshot';
    el.toolCallId = 'call-1';
    el.output = 'screen: /tmp/a.jpg';
    document.body.append(el);
    await vi.waitFor(() => expect(el.frameMode).toBe('frozen'));
    expect(sent).toEqual([{ type: 'computer-watch', id: 'jsh:fake', fps: 2, maxWidth: 480 }]);
    expect(store.isWatching('jsh:fake')).toBe(true);

    applyFrame('jsh:fake');
    await vi.waitFor(() => expect(el.frameMode).toBe('live'));
    expect(el.frameSrc?.startsWith('data:image/jpeg;base64,')).toBe(true);

    el.remove();
    expect(store.isWatching('jsh:fake')).toBe(false);
  });

  it('drops watchers when the thread rebuild disposes the install', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake');
    installWcComputers({ log });
    const el = document.createElement('slicc-bash-renderer-computer');
    el.command = 'computer -c jsh:fake screenshot';
    el.toolCallId = 'call-1';
    document.body.append(el);
    await vi.waitFor(() => expect(store.isWatching('jsh:fake')).toBe(true));
    disposeWcComputersForTests();
    expect(store.isWatching('jsh:fake')).toBe(false);
  });
});
