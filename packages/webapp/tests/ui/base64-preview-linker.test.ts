// @vitest-environment jsdom
/**
 * Tests for the DOM half of the base64 preview.
 *
 * Two properties carry the feature: it must replace a payload it recognized,
 * and it must leave EVERYTHING else byte-identical. The second is the one worth
 * defending — this runs over messages the user wrote.
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import {
  BASE64_PREVIEW_OPEN_EVENT,
  type Base64PreviewOpenDetail,
  BLOB_CHIP_TAG,
  elideBase64Payloads,
} from '../../src/ui/base64-preview-linker.js';

/** Base64 of readable text, long enough to clear the heuristic's length bar. */
function textPayload(seed = 'the quick brown fox jumps over the lazy dog '): string {
  return uint8ToBase64(new TextEncoder().encode(seed.repeat(6)));
}

/** Base64 of a real PNG header followed by filler. */
function pngPayload(): string {
  const bytes = new Uint8Array(200);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return uint8ToBase64(bytes);
}

function body(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function chips(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOB_CHIP_TAG));
}

describe('elideBase64Payloads', () => {
  it('replaces a recognized payload with a chip', () => {
    const root = body(`<p>here it is: ${pngPayload()}</p>`);
    elideBase64Payloads(root);

    expect(chips(root)).toHaveLength(1);
    expect(root.textContent).toContain('here it is:');
    expect(root.textContent).not.toContain('iVBOR');
  });

  it('labels the chip with the type and size', () => {
    const root = body(`<p>${pngPayload()}</p>`);
    elideBase64Payloads(root);

    const [chip] = chips(root);
    expect(chip?.getAttribute('label')).toBe('png · 200 B');
    expect(chip?.getAttribute('icon')).toBe('image');
    expect(chip?.title).toContain('image/png');
  });

  it('keeps the text either side of the payload', () => {
    const root = body(`<p>before ${textPayload()} after</p>`);
    elideBase64Payloads(root);

    expect(root.textContent?.startsWith('before ')).toBe(true);
    expect(root.textContent?.endsWith(' after')).toBe(true);
  });

  it('replaces every payload in a paragraph', () => {
    const root = body(`<p>${pngPayload()} and ${textPayload()}</p>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(2);
  });

  it('processes a payload inside inline code', () => {
    const root = body(`<p>run <code>${pngPayload()}</code></p>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(1);
  });

  it('leaves a fenced code block alone', () => {
    // A code block already scrolls inside itself, and it is the one place
    // someone is asking to see the literal characters.
    const payload = pngPayload();
    const root = body(`<pre><code>${payload}</code></pre>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(0);
    expect(root.textContent).toBe(payload);
  });

  it('leaves an existing link alone', () => {
    const payload = pngPayload();
    const root = body(`<p><a href="#x">${payload}</a></p>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(0);
  });

  it('leaves unrecognizable bytes as they were', () => {
    // 132 base64 characters that decode to no known format and no readable
    // text — the shape of a hash or an opaque id.
    const noise = uint8ToBase64(Uint8Array.from({ length: 120 }, (_, i) => (i * 37) % 256));
    const root = body(`<p>token ${noise} end</p>`);
    const before = root.innerHTML;
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(0);
    expect(root.innerHTML).toBe(before);
  });

  it('leaves ordinary prose untouched', () => {
    const root = body('<p>Rewrote the watcher in check.js and re-ran the suite.</p>');
    const before = root.innerHTML;
    elideBase64Payloads(root);
    expect(root.innerHTML).toBe(before);
  });

  it('is idempotent over unchanged content', () => {
    const root = body(`<p>${pngPayload()}</p>`);
    elideBase64Payloads(root);
    const after = root.innerHTML;
    elideBase64Payloads(root);
    expect(root.innerHTML).toBe(after);
    expect(chips(root)).toHaveLength(1);
  });

  it('re-processes a body whose content was replaced', () => {
    // The fingerprint records WHAT was processed, so reusing the element for
    // different content does not skip it.
    const root = body('<p>nothing here</p>');
    elideBase64Payloads(root);
    root.innerHTML = `<p>${pngPayload()}</p>`;
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(1);
  });

  it('dispatches a composed open event carrying the decoded payload', () => {
    const root = body(`<p>${pngPayload()}</p>`);
    document.body.append(root);
    elideBase64Payloads(root);

    let detail: Base64PreviewOpenDetail | null = null;
    root.addEventListener(BASE64_PREVIEW_OPEN_EVENT, (e) => {
      detail = (e as CustomEvent<Base64PreviewOpenDetail>).detail;
    });
    chips(root)[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(detail).not.toBeNull();
    expect(detail!.payload.mime).toBe('image/png');
    expect(detail!.payload.bytes.byteLength).toBe(200);
    root.remove();
  });
});

describe('elideBase64Payloads — column-wrapped payloads', () => {
  /**
   * What a wrapped paste actually reaches the DOM as. The markdown renderer
   * runs with `breaks: true`, so each newline becomes a `<br>` and each line
   * its own text node — every one of them far below the length bar.
   */
  function wrappedHtml(text: string, cols = 76): string {
    const payload = uint8ToBase64(new TextEncoder().encode(text.repeat(30)));
    const lines: string[] = [];
    for (let i = 0; i < payload.length; i += cols) lines.push(payload.slice(i, i + cols));
    return lines.join('<br>');
  }

  it('sees a payload split across <br> boundaries', () => {
    const root = body(`<p>here it is:<br>${wrappedHtml('wrapped ')}<br>done</p>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(1);
  });

  it('removes the <br>s that were inside the payload', () => {
    // Otherwise a collapsed block leaves a stack of blank lines behind where
    // its wrapping used to be.
    const root = body(`<p>here it is:<br>${wrappedHtml('wrapped ')}<br>done</p>`);
    const before = root.querySelectorAll('br').length;
    elideBase64Payloads(root);
    // The two <br>s bracketing the block survive; every one inside it goes.
    expect(root.querySelectorAll('br')).toHaveLength(2);
    expect(before).toBeGreaterThan(2);
  });

  it('keeps the text either side of a wrapped payload', () => {
    const root = body(`<p>here it is:<br>${wrappedHtml('wrapped ')}<br>done</p>`);
    elideBase64Payloads(root);
    expect(root.textContent).toContain('here it is:');
    expect(root.textContent).toContain('done');
  });

  it('does not join text across a real element boundary', () => {
    // Across a `<strong>` the text was never contiguous, so the two halves
    // must not be spliced into one payload.
    const payload = uint8ToBase64(new TextEncoder().encode('split '.repeat(30)));
    const half = Math.ceil(payload.length / 2);
    const root = body(`<p>${payload.slice(0, half)}<strong>x</strong>${payload.slice(half)}</p>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(0);
  });

  it('leaves a wrapped block inside a code fence alone', () => {
    const root = body(`<pre><code>${wrappedHtml('wrapped ')}</code></pre>`);
    elideBase64Payloads(root);
    expect(chips(root)).toHaveLength(0);
  });

  it('is idempotent over a wrapped payload', () => {
    const root = body(`<p>x<br>${wrappedHtml('wrapped ')}<br>y</p>`);
    elideBase64Payloads(root);
    const after = root.innerHTML;
    elideBase64Payloads(root);
    expect(root.innerHTML).toBe(after);
  });
});
