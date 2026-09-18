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
import { DECODABLE_PNG } from '../../../src/computers/frame-bytes.js';
import { getComputersStore, resetComputersStoreForTests } from '../../../src/ui/computers-store.js';
import {
  bindComputerOverlay,
  computerOverlayId,
  computerToTab,
  disposeWcComputersForTests,
  installWcComputers,
  mergeOverlayTabs,
  parseComputerIdFromCommand,
  parseComputerIdFromOutput,
  parseFrozenFrameHint,
  resolveRendererComputerId,
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
    expect(parseComputerIdFromCommand('computer screenshot')).toBeNull();
    expect(parseComputerIdFromCommand('ls')).toBeNull();
    expect(parseComputerIdFromOutput('target: jsh:fake\nscreen: /tmp/x.jpg')).toBe('jsh:fake');
    expect(resolveRendererComputerId('computer screenshot', 'target: v86:vm0\nok')).toBe('v86:vm0');
    expect(resolveRendererComputerId('computer -c tab:T1 screenshot', 'target: ignored')).toBe(
      'tab:T1'
    );
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

  it('badges ssh overlay titles as input or view-only', () => {
    const view = computerToTab(
      {
        ...descriptor('ssh:follower-abc', 'live'),
        kind: 'ssh',
        title: 'desk',
        capabilities: { ...descriptor().capabilities, inputAllowed: false, keyboard: false },
      },
      null
    );
    expect(view.title).toBe('desk [view-only]');
    const poke = computerToTab(
      {
        ...descriptor('ssh:follower-abc', 'live'),
        kind: 'ssh',
        title: 'desk',
        capabilities: { ...descriptor().capabilities, inputAllowed: true },
      },
      null
    );
    expect(poke.title).toBe('desk [input]');
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

  it('patches overlay thumbnails in place so a focused soft-key survives a new frame', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake', 1);
    installWcComputers({ log });
    const overlay = document.createElement('slicc-tab-overlay') as HTMLElement & {
      tabs: ReturnType<typeof mergeOverlayTabs>;
    };
    document.body.append(overlay);
    bindComputerOverlay(overlay, log);
    overlay.setAttribute('open', '');
    await vi.waitFor(() => expect(overlay.shadowRoot?.querySelector('img.shot')).toBeTruthy());
    const img = overlay.shadowRoot?.querySelector('img.shot');
    const home = overlay.shadowRoot?.querySelector<HTMLButtonElement>('.softkey');
    home?.focus();
    expect(overlay.shadowRoot?.activeElement).toBe(home);
    applyFrame('jsh:fake', 2);
    expect(overlay.shadowRoot?.querySelector('img.shot')).toBe(img);
    expect(overlay.shadowRoot?.activeElement).toBe(home);
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

  it('frozen rows use their own screen: file, then img:, never the live frame', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({ type: 'computers', computers: [descriptor()] });
    applyFrame('jsh:fake');
    const files = new Map<string, Uint8Array>([['/tmp/own.jpg', DECODABLE_PNG]]);
    installWcComputers({
      log,
      openFs: async () => ({
        readFile: async (path: string) => {
          const bytes = files.get(path);
          if (!bytes) throw new Error(`ENOENT ${path}`);
          return bytes;
        },
      }),
    });

    const missingOnly = document.createElement('slicc-bash-renderer-computer');
    missingOnly.command = 'computer -c jsh:fake screenshot';
    missingOnly.toolCallId = 'call-0';
    missingOnly.output = 'screen: /tmp/missing.jpg';
    document.body.append(missingOnly);

    const missingThenImg = document.createElement('slicc-bash-renderer-computer');
    missingThenImg.command = 'computer -c jsh:fake screenshot';
    missingThenImg.toolCallId = 'call-1';
    missingThenImg.output = 'screen: /tmp/missing.jpg\n<img:data:image/jpeg;base64,QUJD>';
    document.body.append(missingThenImg);

    const ownFile = document.createElement('slicc-bash-renderer-computer');
    ownFile.command = 'computer -c jsh:fake screenshot';
    ownFile.toolCallId = 'call-2';
    ownFile.output = 'screen: /tmp/own.jpg';
    document.body.append(ownFile);

    const live = document.createElement('slicc-bash-renderer-computer');
    live.command = 'computer -c jsh:fake screenshot';
    live.toolCallId = 'call-3';
    live.output = 'screen: /tmp/b.jpg';
    document.body.append(live);
    await vi.waitFor(() => expect(live.frameMode).toBe('live'));
    await vi.waitFor(() => expect(ownFile.frameMode).toBe('frozen'));
    await vi.waitFor(() =>
      expect(ownFile.frameSrc?.startsWith('data:image/png;base64,')).toBe(true)
    );
    expect(ownFile.frameSrc).not.toBe(live.frameSrc);
    await vi.waitFor(() => expect(missingThenImg.frameMode).toBe('frozen'));
    await vi.waitFor(() => expect(missingThenImg.frameSrc).toBe('data:image/jpeg;base64,QUJD'));
    await vi.waitFor(() => expect(missingOnly.frameMode).toBe('frozen'));
    await vi.waitFor(() => expect(missingOnly.frameSrc).toBeNull());
  });

  it('does not paint a frozen file that resolves after the row goes live', async () => {
    const store = getComputersStore();
    store.setSender(() => undefined);
    store.applyList({ type: 'computers', computers: [descriptor()] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installWcComputers({
      log,
      openFs: async () => ({
        readFile: async () => {
          await gate;
          return DECODABLE_PNG;
        },
      }),
    });

    const el = document.createElement('slicc-bash-renderer-computer');
    el.command = 'computer -c jsh:fake screenshot';
    el.toolCallId = 'call-1';
    el.output = 'screen: /tmp/a.jpg';
    document.body.append(el);
    await vi.waitFor(() => expect(el.frameMode).toBe('frozen'));

    applyFrame('jsh:fake');
    await vi.waitFor(() => expect(el.frameMode).toBe('live'));
    const liveSrc = el.frameSrc;
    expect(liveSrc?.startsWith('data:image/jpeg;base64,')).toBe(true);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.frameMode).toBe('live');
    expect(el.frameSrc).toBe(liveSrc);
    expect(el.frameSrc?.startsWith('data:image/png;base64,')).toBe(false);
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

  it('watches a live row whose command has no -c when stdout stamps target:', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    installWcComputers({ log });

    const el = document.createElement('slicc-bash-renderer-computer');
    el.command = 'computer screenshot';
    el.toolCallId = 'call-1';
    el.output = 'target: jsh:fake\nscreen: /tmp/a.jpg';
    document.body.append(el);
    await vi.waitFor(() => expect(el.computerId).toBe('jsh:fake'));
    expect(sent).toEqual([{ type: 'computer-watch', id: 'jsh:fake', fps: 2, maxWidth: 480 }]);
    expect(store.isWatching('jsh:fake')).toBe(true);

    applyFrame('jsh:fake');
    await vi.waitFor(() => expect(el.frameMode).toBe('live'));
    el.remove();
    expect(store.isWatching('jsh:fake')).toBe(false);
  });

  it('opens a static frozen preview without watching when no target is available', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({ type: 'computers', computers: [descriptor()] });
    installWcComputers({ log });

    const src = 'data:image/jpeg;base64,QUJD';
    const el = document.createElement('slicc-bash-renderer-computer');
    el.command = 'cat /tmp/shot.jpg';
    el.toolCallId = 'call-static';
    el.output = `<img:${src}>`;
    document.body.append(el);
    await vi.waitFor(() => expect(el.frameMode).toBe('frozen'));
    expect(store.isWatching('jsh:fake')).toBe(false);

    el.dispatchEvent(
      new CustomEvent('computer-frame-click', { detail: { src }, bubbles: true, composed: true })
    );
    const preview = document.querySelector('slicc-image-preview');
    expect(preview?.hasAttribute('open')).toBe(true);
    expect(sent).toEqual([]);
    expect(store.isWatching('jsh:fake')).toBe(false);
    expect(preview?.hasAttribute('drive')).toBe(false);
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

  it('enables lightbox drive on a live inputAllowed frame and maps clicks to native', () => {
    const store = getComputersStore();
    const sent: Array<{ type: string; id?: string; events?: unknown[] }> = [];
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
    const preview = document.querySelector('slicc-image-preview');
    expect(preview?.hasAttribute('drive')).toBe(true);

    preview?.dispatchEvent(
      new CustomEvent('slicc-image-preview-input', {
        bubbles: true,
        detail: { kind: 'click', button: 1, x: 50, y: 25, width: 100, height: 50 },
      })
    );
    preview?.dispatchEvent(
      new CustomEvent('slicc-image-preview-input', {
        bubbles: true,
        detail: {
          kind: 'key',
          key: 'a',
          code: 'KeyA',
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
        },
      })
    );
    preview?.dispatchEvent(
      new CustomEvent('slicc-image-preview-input', {
        bubbles: true,
        detail: {
          kind: 'key',
          key: 'Escape',
          code: 'Escape',
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
        },
      })
    );
    const inputs = sent.filter((m) => m.type === 'computer-input');
    expect(inputs).toEqual([
      {
        type: 'computer-input',
        id: 'jsh:fake',
        events: [{ type: 'click', button: 1, count: 1, x: 4, y: 4 }],
      },
      { type: 'computer-input', id: 'jsh:fake', events: [{ type: 'key', keysym: 'a' }] },
    ]);
  });

  it('does not drive a view-only lightbox or a frozen bash-row still', async () => {
    const store = getComputersStore();
    const sent: Array<{ type: string }> = [];
    store.setSender((msg) => sent.push(msg));
    store.applyList({
      type: 'computers',
      computers: [
        {
          ...descriptor(),
          capabilities: { ...descriptor().capabilities, inputAllowed: false },
        },
      ],
    });
    applyFrame('jsh:fake');
    installWcComputers({ log });
    const overlay = document.createElement('slicc-tab-overlay') as HTMLElement & {
      tabs: ReturnType<typeof mergeOverlayTabs>;
    };
    document.body.append(overlay);
    bindComputerOverlay(overlay, log);
    overlay.dispatchEvent(
      new CustomEvent('tab-activate', { detail: { id: computerOverlayId('jsh:fake') } })
    );
    const livePreview = document.querySelector('slicc-image-preview');
    expect(livePreview?.hasAttribute('drive')).toBe(false);
    livePreview?.dispatchEvent(
      new CustomEvent('slicc-image-preview-input', {
        bubbles: true,
        detail: { kind: 'click', button: 1, x: 1, y: 1, width: 8, height: 8 },
      })
    );
    expect(sent.filter((m) => m.type === 'computer-input')).toEqual([]);
    livePreview?.dispatchEvent(new CustomEvent('slicc-image-preview-close', { bubbles: true }));

    store.applyList({ type: 'computers', computers: [descriptor()] });
    const frozen = document.createElement('slicc-bash-renderer-computer');
    frozen.command = 'computer -c jsh:fake screenshot';
    frozen.toolCallId = 'call-frozen';
    frozen.output = 'screen: /tmp/a.jpg';
    document.body.append(frozen);
    const live = document.createElement('slicc-bash-renderer-computer');
    live.command = 'computer -c jsh:fake key Return';
    live.toolCallId = 'call-live';
    live.output = 'screen: /tmp/b.jpg';
    document.body.append(live);
    await vi.waitFor(() => expect(live.frameMode).toBe('live'));
    await vi.waitFor(() => expect(frozen.frameMode).toBe('frozen'));
    sent.length = 0;
    frozen.dispatchEvent(
      new CustomEvent('computer-frame-click', {
        detail: { src: 'data:image/jpeg;base64,QUJD' },
        bubbles: true,
        composed: true,
      })
    );
    const frozenPreview = document.querySelector('slicc-image-preview');
    expect(frozenPreview?.hasAttribute('drive')).toBe(false);
    frozenPreview?.dispatchEvent(
      new CustomEvent('slicc-image-preview-input', {
        bubbles: true,
        detail: { kind: 'click', button: 1, x: 1, y: 1, width: 8, height: 8 },
      })
    );
    expect(sent.filter((m) => m.type === 'computer-input')).toEqual([]);
  });
});
