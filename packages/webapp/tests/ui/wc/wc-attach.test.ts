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
  it('inlines text files as text with a mime from the extension', () => {
    const att = attachmentFromBytes('notes.md', new TextEncoder().encode('hello'));
    expect(att.kind).toBe('text');
    expect(att.text).toBe('hello');
    expect(att.mimeType).toBe('text/markdown');
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
  async function setup() {
    const fs = await seededFs();
    const inputCard = document.createElement('slicc-input-card') as HTMLElement & {
      value?: string;
    };
    const freezer = document.createElement('slicc-freezer');
    document.body.append(inputCard, freezer);
    const stage = wireWcAttach({
      inputCard,
      freezer,
      openReader: async () => fs,
      listConversations: async () => [],
      log,
    });
    return { fs, inputCard, freezer, stage };
  }

  function emitAdd(inputCard: HTMLElement, detail: Record<string, unknown>): void {
    inputCard.dispatchEvent(new CustomEvent('slicc-add', { bubbles: true, detail }));
  }

  it('stages an uploaded File', async () => {
    const { inputCard, stage } = await setup();
    emitAdd(inputCard, {
      kind: 'upload',
      name: 'drop.md',
      size: 4,
      file: new File(['drop'], 'drop.md', { type: 'text/markdown' }),
    });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['drop.md']);
    });
    expect(stage.items[0].text).toBe('drop');
  });

  it('stages a VFS file pick read through the reader', async () => {
    const { inputCard, stage } = await setup();
    emitAdd(inputCard, { kind: 'file', id: '/workspace/notes.md', label: 'notes.md' });
    await vi.waitFor(() => {
      expect(stage.items.map((a) => a.name)).toEqual(['notes.md']);
    });
    expect(stage.items[0].text).toContain('notes with');
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
