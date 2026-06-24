// @vitest-environment jsdom
/**
 * Wave 9b — composer photo/video capture + screen-capture surface routing.
 *
 * Pins that:
 * - Inline photo/video capture probes camera + microphone through the
 *   leader `<slicc-permissions>` surface BEFORE mounting
 *   `<slicc-composer-capture>`, and aborts cleanly when the user cancels.
 * - Screen capture (`mode:'screen'`) routes through
 *   `surface.request('screenshare')` and uses the granted stream
 *   directly (no separate `navigator.mediaDevices.getDisplayMedia` call).
 *
 * `wc-attach.test.ts` already covers the no-surface fallback shape (those
 * tests don't mount a surface so `getLeaderPermissionsSurface()` returns
 * `null` and the legacy `<slicc-composer-capture>` / `getDisplayMedia`
 * paths run unchanged). This file flips the surface ON via a module mock.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

const surfaceMock = vi.hoisted(() => ({
  prompt: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => surfaceMock,
}));

import { VirtualFS } from '../../../src/fs/index.js';
import { UPLOAD_DIR, wireWcAttach } from '../../../src/ui/wc/wc-attach.js';

const log = { error: vi.fn() };

async function seededFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({
    dbName: `wc-attach-surface-${Math.random()}`,
    wipe: true,
  });
  await fs.mkdir('/workspace');
  await fs.mkdir('/shared');
  return fs;
}

// Lightweight stub matching wc-attach.test.ts's pattern: defer/resolve the
// `open()` promise so we can inspect mid-flight state.
type StubResult = {
  kind: 'image';
  mimeType: string;
  width: number;
  height: number;
  dataUrl: string;
} | null;
let stubResult: StubResult = null;
class CaptureStub extends HTMLElement {
  open(_mode?: 'photo' | 'video'): Promise<StubResult> {
    return Promise.resolve(stubResult);
  }
}
if (!customElements.get('slicc-composer-capture')) {
  customElements.define('slicc-composer-capture', CaptureStub);
}

function makeStream(): MediaStream {
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  return stream as unknown as MediaStream;
}

async function setup(opts: { withWriter?: boolean } = {}) {
  const fs = await seededFs();
  const inputCard = document.createElement('slicc-input-card') as HTMLElement;
  const freezer = document.createElement('slicc-freezer');
  const composer = document.createElement('div');
  composer.style.position = 'relative';
  document.body.append(inputCard, freezer, composer);
  const stage = wireWcAttach({
    inputCard,
    freezer,
    composer,
    openReader: async () => fs,
    openWriter: opts.withWriter === false ? undefined : async () => fs,
    listConversations: async () => [],
    log,
  });
  return { fs, inputCard, composer, stage };
}

function emitAdd(inputCard: HTMLElement, detail: Record<string, unknown>): void {
  inputCard.dispatchEvent(new CustomEvent('slicc-add', { bubbles: true, detail }));
}

beforeEach(() => {
  surfaceMock.prompt.mockReset();
  surfaceMock.request.mockReset();
  stubResult = null;
  for (const el of document.body.querySelectorAll(
    'slicc-input-card, slicc-freezer, div, slicc-composer-capture'
  )) {
    el.remove();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Wave 9b — inline photo/video capture routes through <slicc-permissions>', () => {
  it('probes camera + microphone via surface.prompt before mounting the capture element', async () => {
    const stream = makeStream();
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [
        { kind: 'camera', stream },
        { kind: 'microphone', stream: makeStream() },
      ],
    });
    stubResult = {
      kind: 'image',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${btoa('snap')}`,
    };
    const { inputCard, stage } = await setup();
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    await vi.waitFor(() => {
      expect(stage.items).toHaveLength(1);
    });
    // Surface was the gesture-gate: prompt called with BOTH kinds so the
    // in-component mode toggle (photo ↔ video) doesn't trigger a second
    // native browser prompt.
    expect(surfaceMock.prompt).toHaveBeenCalledTimes(1);
    const promptArg = surfaceMock.prompt.mock.calls[0][0];
    expect(promptArg.kinds).toEqual(['camera', 'microphone']);
    expect(typeof promptArg.description).toBe('string');
  });

  it('skips the capture element entirely when the surface prompt is cancelled', async () => {
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'cancelled',
      grants: [],
      reason: 'cancelled',
    });
    const { inputCard, composer, stage } = await setup();
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    // Give the async chain time to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(composer.querySelector('slicc-composer-capture')).toBeNull();
    expect(stage.items).toHaveLength(0);
  });
});

describe('Wave 9b — screen capture routes through <slicc-permissions>', () => {
  it('uses surface.request("screenshare") and grabs a frame from the granted stream', async () => {
    // Build a minimal MediaStream-like that grabFrame can consume. We stub
    // both video metadata + canvas plumbing so the frame grab resolves
    // without a real getDisplayMedia.
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    surfaceMock.request.mockResolvedValueOnce({ kind: 'screenshare', stream });

    // Stub canvas + video so `grabFrame` produces a deterministic data URL.
    const origToDataUrl = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      return `data:image/png;base64,${btoa('screen')}`;
    };
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get: () => 16,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get: () => 16,
    });
    const origPlay = HTMLVideoElement.prototype.play;
    HTMLVideoElement.prototype.play = async function () {
      return undefined;
    };
    try {
      const { inputCard, stage } = await setup();
      emitAdd(inputCard, { kind: 'capture', mode: 'screen' });
      await vi.waitFor(() => {
        expect(stage.items).toHaveLength(1);
      });
      expect(surfaceMock.request).toHaveBeenCalledWith('screenshare', {
        constraints: { video: true },
      });
      const item = stage.items[0];
      expect(item.kind).toBe('image');
      expect(item.name).toMatch(/^screenshot-\d+\.png$/);
      expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    } finally {
      HTMLCanvasElement.prototype.toDataURL = origToDataUrl;
      HTMLVideoElement.prototype.play = origPlay;
    }
  });

  it('skips the staged screenshot when the screenshare surface request returns null', async () => {
    surfaceMock.request.mockResolvedValueOnce(null);
    const { inputCard, stage } = await setup();
    emitAdd(inputCard, { kind: 'capture', mode: 'screen' });
    await new Promise((r) => setTimeout(r, 20));
    expect(stage.items).toHaveLength(0);
  });
});
