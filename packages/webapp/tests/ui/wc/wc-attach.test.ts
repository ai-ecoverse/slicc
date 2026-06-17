// @vitest-environment jsdom
/**
 * Add-menu wiring: attachment building rules, the real-data search provider
 * (over an in-memory VFS), the staged-chips lifecycle, and the slicc-add
 * action routing — uploads, VFS picks, skill inserts, conversation thaws.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { VirtualFS } from '../../../src/fs/index.js';
import {
  attachmentFromBytes,
  attachmentFromCapture,
  attachmentFromDataUrl,
  attachmentFromVideoBlob,
  createAddProvider,
  persistUpload,
  UPLOAD_DIR,
  WcAttachmentStage,
  wireWcAttach,
} from '../../../src/ui/wc/wc-attach.js';

const log = { error: vi.fn() };

async function seededFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `wc-attach-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace');
  await fs.mkdir('/workspace/skills');
  await fs.mkdir('/workspace/skills/sprinkles');
  await fs.mkdir('/shared');
  await fs.writeFile('/workspace/notes.md', '# notes with **bold**');
  await fs.writeFile('/shared/data.json', '{"a":1}');
  return fs;
}

describe('attachmentFromBytes', () => {
  it('references text and binary files without inlining (no text decode)', () => {
    const text = attachmentFromBytes('notes.md', new TextEncoder().encode('hello'));
    expect(text.kind).toBe('file');
    expect(text.text).toBeUndefined();
    expect(text.data).toBeUndefined();
    expect(text.mimeType).toBe('text/markdown');

    // Binary bytes are never UTF-8-decoded — no mojibake, no inline content.
    const bin = attachmentFromBytes('archive.zip', new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    expect(bin.kind).toBe('file');
    expect(bin.text).toBeUndefined();
    expect(bin.data).toBeUndefined();

    // Oversized non-images keep only a fallback label (no inline content).
    const big = attachmentFromBytes('big.bin', new Uint8Array(512 * 1024));
    expect(big.kind).toBe('file');
    expect(big.error).toContain('too large');
    expect(big.text).toBeUndefined();
  });

  it('inlines images as base64 and flags oversized payloads instead', () => {
    const img = attachmentFromBytes('shot.png', new Uint8Array([1, 2, 3]));
    expect(img.kind).toBe('image');
    expect(img.data).toBe(btoa(String.fromCharCode(1, 2, 3)));

    const huge = attachmentFromBytes('huge.png', new Uint8Array(5 * 1024 * 1024));
    expect(huge.error).toContain('too large');
    expect(huge.data).toBeUndefined();
  });
});

describe('attachmentFromDataUrl', () => {
  it('parses a PNG data URL into an image attachment and rejects non-images', () => {
    const att = attachmentFromDataUrl('p.png', `data:image/png;base64,${btoa('xx')}`);
    expect(att?.kind).toBe('image');
    expect(att?.data).toBe(btoa('xx'));
    expect(attachmentFromDataUrl('p.txt', 'data:text/plain;base64,eHg=')).toBeNull();
  });
});

describe('createAddProvider', () => {
  it('returns real files, skills, and conversations filtered by the query', async () => {
    const fs = await seededFs();
    const provider = createAddProvider({
      openReader: async () => fs,
      listConversations: async () => [
        { id: 'a.md', label: 'Dark mode toggle' },
        { id: 'b.md', label: 'Mount recovery' },
      ],
    });

    const all = await provider('');
    const byKind = Object.fromEntries(all.map((s) => [s.kind, s]));
    expect(byKind.file.entries.map((e) => e.id)).toContain('/workspace/notes.md');
    expect(byKind.skill.entries.map((e) => e.id)).toContain('sprinkles');
    expect(byKind.conversation.entries).toHaveLength(2);

    const filtered = await provider('dark');
    const conv = filtered.find((s) => s.kind === 'conversation');
    expect(conv?.entries.map((e) => e.label)).toEqual(['Dark mode toggle']);
    expect(filtered.find((s) => s.kind === 'file')?.entries).toHaveLength(0);
  });

  it('finds deeply nested files and skips node_modules', async () => {
    const fs = await seededFs();
    await fs.mkdir('/workspace/a');
    await fs.mkdir('/workspace/a/b');
    await fs.mkdir('/workspace/a/b/c');
    await fs.mkdir('/workspace/a/b/c/d');
    await fs.writeFile('/workspace/a/b/c/d/deep-needle.ts', 'x');
    await fs.mkdir('/workspace/node_modules');
    await fs.mkdir('/workspace/node_modules/pkg');
    await fs.writeFile('/workspace/node_modules/pkg/haystack-noise.js', 'x');

    const provider = createAddProvider({
      openReader: async () => fs,
      listConversations: async () => [],
    });
    const sections = await provider('needle');
    const files = sections.find((s) => s.kind === 'file');
    expect(files?.entries.map((e) => e.id)).toEqual(['/workspace/a/b/c/d/deep-needle.ts']);

    const noise = await provider('haystack-noise');
    expect(noise.find((s) => s.kind === 'file')?.entries).toHaveLength(0);
  });
});

describe('capture persistence (/tmp/upload)', () => {
  it('persistUpload writes under /tmp/upload with a sanitized name', async () => {
    const fs = await seededFs();
    const path = await persistUpload(fs, 'my photo (1).png', new Uint8Array([1, 2]));
    expect(path.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    expect(path.endsWith('-my_photo_1_.png')).toBe(true);
    const raw = await fs.readFile(path);
    expect((raw as Uint8Array).length).toBe(2);
  });

  it('attachmentFromCapture saves the original to the VFS and links its path', async () => {
    const fs = await seededFs();
    const dataUrl = `data:image/png;base64,${btoa('full-res-bytes')}`;
    const attachment = await attachmentFromCapture('shot.png', dataUrl, fs);
    expect(attachment?.kind).toBe('image');
    // Inline copy retained for vision…
    expect(attachment?.data).toBeTruthy();
    // …and the original persisted + linked.
    expect(attachment?.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = await fs.readFile(attachment?.path as string, { encoding: 'utf-8' });
    expect(typeof saved === 'string' ? saved : new TextDecoder().decode(saved)).toBe(
      'full-res-bytes'
    );
  });

  it('attachmentFromCapture still works without a writer (no path)', async () => {
    const dataUrl = `data:image/png;base64,${btoa('x')}`;
    const attachment = await attachmentFromCapture('shot.png', dataUrl, null);
    expect(attachment?.data).toBe(btoa('x'));
    expect(attachment?.path).toBeUndefined();
  });
});

describe('attachmentFromVideoBlob', () => {
  it('persists the WebM under /tmp/upload as a kind:file (no inline data)', async () => {
    const fs = await seededFs();
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x00]); // mock WebM header bytes
    const blob = new Blob([bytes], { type: 'video/webm' });
    const attachment = await attachmentFromVideoBlob('clip.webm', blob, fs);
    expect(attachment?.kind).toBe('file');
    expect(attachment?.mimeType).toBe('video/webm');
    expect(attachment?.size).toBe(bytes.length);
    expect(attachment?.data).toBeUndefined();
    expect(attachment?.text).toBeUndefined();
    expect(attachment?.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = (await fs.readFile(attachment?.path as string, {
      encoding: 'binary',
    })) as Uint8Array;
    expect(Array.from(saved)).toEqual(Array.from(bytes));
  });

  it('returns null without a writer (a video chip without a path is useless)', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' });
    expect(await attachmentFromVideoBlob('clip.webm', blob, null)).toBeNull();
  });

  it('falls back to video/webm when the Blob carries no MIME type', async () => {
    const fs = await seededFs();
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const attachment = await attachmentFromVideoBlob('clip.webm', blob, fs);
    expect(attachment?.mimeType).toBe('video/webm');
  });
});

describe('WcAttachmentStage', () => {
  it('renders image attachments with a data-URI thumbnail', () => {
    const card = document.createElement('slicc-input-card');
    document.body.appendChild(card);
    const stage = new WcAttachmentStage(card);

    stage.add(attachmentFromBytes('snap.png', new Uint8Array([1, 2, 3])));
    stage.add(attachmentFromBytes('notes.md', new TextEncoder().encode('text')));

    const thumbs = card.querySelectorAll<HTMLImageElement>('.wcatt__thumb');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].src).toBe(`data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}`);
    expect(thumbs[0].alt).toBe('snap.png');
    // Text chips carry no thumbnail.
    const chips = card.querySelectorAll('.wcatt__chip');
    expect(chips[1].querySelector('.wcatt__thumb')).toBeNull();
  });

  it('renders chips, removes on ×, and take() clears the stage', () => {
    const card = document.createElement('slicc-input-card');
    document.body.appendChild(card);
    const stage = new WcAttachmentStage(card);

    stage.add(attachmentFromBytes('a.md', new TextEncoder().encode('a')));
    stage.add(attachmentFromBytes('b.md', new TextEncoder().encode('b')));
    expect(card.querySelectorAll('.wcatt__chip')).toHaveLength(2);

    (card.querySelector('.wcatt__x') as HTMLElement).click();
    expect(card.querySelectorAll('.wcatt__chip')).toHaveLength(1);
    expect(stage.items.map((a) => a.name)).toEqual(['b.md']);

    const taken = stage.take();
    expect(taken.map((a) => a.name)).toEqual(['b.md']);
    expect(stage.items).toHaveLength(0);
    expect(card.querySelectorAll('.wcatt__chip')).toHaveLength(0);
  });
});

describe('wireWcAttach action routing', () => {
  async function setup(opts: { withWriter?: boolean; composer?: HTMLElement } = {}) {
    const fs = await seededFs();
    const inputCard = document.createElement('slicc-input-card') as HTMLElement & {
      value?: string;
    };
    const freezer = document.createElement('slicc-freezer');
    document.body.append(inputCard, freezer);
    const stage = wireWcAttach({
      inputCard,
      freezer,
      composer: opts.composer,
      openReader: async () => fs,
      openWriter: opts.withWriter === false ? undefined : async () => fs,
      listConversations: async () => [],
      log,
    });
    return { fs, inputCard, freezer, stage };
  }

  function emitAdd(inputCard: HTMLElement, detail: Record<string, unknown>): void {
    inputCard.dispatchEvent(new CustomEvent('slicc-add', { bubbles: true, detail }));
  }

  it('persists an uploaded text file to /tmp/upload by reference (no inline text)', async () => {
    const { fs, inputCard, stage } = await setup();
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'drop.md',
      size: 4,
      file: new File(['drop'], 'drop.md', { type: 'text/markdown' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['drop.md']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('file');
    expect(item.text).toBeUndefined();
    expect(item.error).toBeUndefined();
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const raw = await fs.readFile(item.path as string, { encoding: 'utf-8' });
    expect(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)).toBe('drop');
  });

  it('persists a binary/zip upload to /tmp/upload without decoding bytes', async () => {
    const { fs, inputCard, stage } = await setup();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'pkg.zip',
      size: bytes.length,
      file: new File([bytes], 'pkg.zip', { type: 'application/zip' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['pkg.zip']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('file');
    expect(item.text).toBeUndefined();
    expect(item.data).toBeUndefined();
    expect(item.error).toBeUndefined();
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = (await fs.readFile(item.path as string, { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(saved)).toEqual(Array.from(bytes));
  });

  it('degrades an upload to a not-included note when no writer is available', async () => {
    const { inputCard, stage } = await setup({ withWriter: false });
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'drop.txt',
      size: 4,
      file: new File(['drop'], 'drop.txt', { type: 'text/plain' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['drop.txt']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('file');
    expect(item.text).toBeUndefined();
    expect(item.path).toBeUndefined();
    expect(item.error).toBe('could not be saved to the virtual filesystem');
  });

  it('keeps an image inline AND persists the original to /tmp/upload', async () => {
    const { fs, inputCard, stage } = await setup();
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'pic.png',
      size: 3,
      file: new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['pic.png']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('image');
    expect(item.data).toBe(btoa(String.fromCharCode(1, 2, 3)));
    expect(item.error).toBeUndefined();
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = (await fs.readFile(item.path as string, { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(saved)).toEqual([1, 2, 3]);
  });

  it('persists an over-4MB image to /tmp/upload with no inline data and no leftover error', async () => {
    const { fs, inputCard, stage } = await setup();
    const big = new Uint8Array(5 * 1024 * 1024);
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'huge.png',
      size: big.length,
      file: new File([big], 'huge.png', { type: 'image/png' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['huge.png']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('image');
    expect(item.data).toBeUndefined();
    expect(item.error).toBeUndefined();
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = (await fs.readFile(item.path as string)) as Uint8Array;
    expect(saved.length).toBe(big.length);
  });

  it('references a VFS file pick by its existing path without inlining', async () => {
    const { inputCard, stage } = await setup();
    emitAdd(inputCard, { kind: 'file', id: '/workspace/notes.md', label: 'notes.md' });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['notes.md']);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('file');
    expect(item.text).toBeUndefined();
    expect(item.path).toBe('/workspace/notes.md');
  });

  it('inserts a skill mention into the composer value', async () => {
    const { inputCard } = await setup();
    inputCard.setAttribute('value', 'please');
    emitAdd(inputCard, { kind: 'skill', id: 'sprinkles', label: 'sprinkles' });
    await vi.waitFor(() => {
      expect(inputCard.getAttribute('value')).toBe('please Use the "sprinkles" skill: ');
    });
  });

  it('routes a conversation pick through the freezer-card-select path', async () => {
    const { inputCard, freezer } = await setup();
    const selects: string[] = [];
    freezer.addEventListener('freezer-card-select', (e) =>
      selects.push((e as CustomEvent<{ slug: string }>).detail.slug)
    );
    emitAdd(inputCard, { kind: 'conversation', id: '2026-06-11-session.md', label: 'Session' });
    await vi.waitFor(() => {
      expect(selects).toEqual(['2026-06-11-session.md']);
    });
  });
});

// Stub the `<slicc-composer-capture>` element once so the inline-overlay tests
// can drive the capture flow without a real camera or the full library load.
// The stub keeps the public `open()` contract (resolves a `CaptureResult | null`)
// so the wiring exercises the real photo/video result branches.
type StubResult =
  | { kind: 'image'; mimeType: string; width: number; height: number; dataUrl: string }
  | { kind: 'video'; mimeType: string; width: number; height: number; blob: Blob }
  | null;
let stubResult: StubResult = null;
let stubDeferred: { promise: Promise<StubResult>; resolve: (v: StubResult) => void } | null = null;
const liveStubs = new Set<HTMLElement>();
class CaptureStub extends HTMLElement {
  open(mode?: 'photo' | 'video'): Promise<StubResult> {
    (this as HTMLElement & { __mode?: string }).__mode = mode ?? 'photo';
    liveStubs.add(this);
    if (stubDeferred) return stubDeferred.promise;
    return Promise.resolve(stubResult);
  }
  disconnectedCallback(): void {
    liveStubs.delete(this);
  }
}
if (!customElements.get('slicc-composer-capture')) {
  customElements.define('slicc-composer-capture', CaptureStub);
}

describe('wireWcAttach inline capture overlay', () => {
  async function setup(opts: { withWriter?: boolean } = {}) {
    const fs = await seededFs();
    const inputCard = document.createElement('slicc-input-card') as HTMLElement & {
      value?: string;
    };
    const freezer = document.createElement('slicc-freezer');
    // The composer-band host is `<slicc-composer>` in the live shell — a
    // `position:relative` element so the compact capture surface's absolute
    // placement anchors against it. A bare div with the same property
    // exercises the same wiring without booting the library.
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

  it('mounts the capture surface on the composer band with compact drop-target placement and removes it after open() resolves', async () => {
    const { inputCard, composer, stage } = await setup();
    stubResult = {
      kind: 'image',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${btoa('snap')}`,
    };
    let liveCapture: HTMLElement | null = null;
    // Hold the open() resolution so we can inspect the live surface placement
    // before the wiring tears it down.
    let resolveOpen!: (v: StubResult) => void;
    stubDeferred = {
      promise: new Promise<StubResult>((r) => {
        resolveOpen = r;
      }),
      resolve: (v) => resolveOpen(v),
    };
    try {
      emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
      await vi.waitFor(() => {
        liveCapture = composer.querySelector<HTMLElement>('slicc-composer-capture');
        expect(liveCapture).toBeTruthy();
      });
      // Compact drop-target geometry: absolute placement, popped UP out of
      // the band's top edge, constrained to the composer's inner-column
      // width (max 680px, centered via translateX). No `inset:0` full-pane
      // takeover — the composer band's height never grows.
      const style = (liveCapture as unknown as HTMLElement).style;
      expect(style.position).toBe('absolute');
      expect(style.maxWidth).toBe('680px');
      expect(style.bottom).toMatch(/100%/);
      expect(style.transform).toContain('translateX(-50%)');
      expect(style.zIndex).toBe('3');
      resolveOpen(stubResult);
    } finally {
      stubDeferred = null;
    }
    // The surface is appended during open() and removed on resolve — so the
    // staged item is the post-condition we wait on.
    await vi.waitFor(() => {
      expect(stage.items).toHaveLength(1);
    });
    expect(composer.querySelector('slicc-composer-capture')).toBeNull();
  });

  it('stages a photo capture result as an image attachment (inline data + VFS path)', async () => {
    const { fs, inputCard, stage } = await setup();
    stubResult = {
      kind: 'image',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${btoa('snap')}`,
    };
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    await vi.waitFor(() => {
      expect(stage.items).toHaveLength(1);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('image');
    expect(item.name).toMatch(/^photo-\d+\.png$/);
    expect(item.data).toBe(btoa('snap'));
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = await fs.readFile(item.path as string, { encoding: 'utf-8' });
    expect(typeof saved === 'string' ? saved : new TextDecoder().decode(saved)).toBe('snap');
  });

  it('stages a video capture result as a kind:file with the WebM persisted to /tmp/upload', async () => {
    const { fs, inputCard, stage } = await setup();
    const videoBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82]);
    stubResult = {
      kind: 'video',
      mimeType: 'video/webm;codecs=vp9,opus',
      width: 640,
      height: 480,
      blob: new Blob([videoBytes], { type: 'video/webm' }),
    };
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    await vi.waitFor(() => {
      expect(stage.items).toHaveLength(1);
    });
    const item = stage.items[0];
    expect(item.kind).toBe('file');
    expect(item.name).toMatch(/^video-\d+\.webm$/);
    expect(item.mimeType).toBe('video/webm');
    expect(item.data).toBeUndefined();
    expect(item.path?.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
    const saved = (await fs.readFile(item.path as string, {
      encoding: 'binary',
    })) as Uint8Array;
    expect(Array.from(saved)).toEqual(Array.from(videoBytes));
  });

  it('cancel resolves to no attachment and tears down the surface', async () => {
    const { inputCard, composer, stage } = await setup();
    stubResult = null;
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    // No staged items; the surface was removed.
    await vi.waitFor(() => {
      expect(composer.querySelector('slicc-composer-capture')).toBeNull();
    });
    expect(stage.items).toHaveLength(0);
  });

  it('drops a video result when no writer is available (no orphan chip)', async () => {
    const { inputCard, stage } = await setup({ withWriter: false });
    stubResult = {
      kind: 'video',
      mimeType: 'video/webm',
      width: 1,
      height: 1,
      blob: new Blob([new Uint8Array([1])], { type: 'video/webm' }),
    };
    emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
    // Give the async chain a chance to settle without staging anything.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stage.items).toHaveLength(0);
  });

  it('persists camera + mic picks via slicc-capture-device-change', async () => {
    // Seed the preference store fresh — other tests in the suite may have
    // written values we'd otherwise be asserting against by accident.
    localStorage.removeItem('slicc_camera_device');
    localStorage.removeItem('slicc_microphone_device');
    // Pause the open() resolution so the overlay stays mounted while we
    // dispatch device-change events on the live element.
    let resolveOpen!: (v: StubResult) => void;
    stubDeferred = {
      promise: new Promise<StubResult>((r) => {
        resolveOpen = r;
      }),
      resolve: (v) => resolveOpen(v),
    };
    try {
      const { inputCard } = await setup();
      emitAdd(inputCard, { kind: 'capture', mode: 'photo' });
      // Wait for the overlay to mount.
      let live: HTMLElement | null = null;
      await vi.waitFor(() => {
        live = [...liveStubs][0] ?? null;
        expect(live).toBeTruthy();
      });
      live?.dispatchEvent(
        new CustomEvent('slicc-capture-device-change', {
          bubbles: true,
          composed: true,
          detail: { deviceId: 'cam-42', kind: 'camera' },
        })
      );
      live?.dispatchEvent(
        new CustomEvent('slicc-capture-device-change', {
          bubbles: true,
          composed: true,
          detail: { deviceId: 'mic-99', kind: 'microphone' },
        })
      );
      expect(localStorage.getItem('slicc_camera_device')).toBe('cam-42');
      expect(localStorage.getItem('slicc_microphone_device')).toBe('mic-99');
      resolveOpen(null);
    } finally {
      stubDeferred = null;
    }
  });
});
