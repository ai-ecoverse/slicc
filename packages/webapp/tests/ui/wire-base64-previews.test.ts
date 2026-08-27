// @vitest-environment jsdom
/**
 * Tests for the base64-preview wiring's lifecycle.
 *
 * Two properties matter here and neither is about base64. The first is
 * containment: this runs partway through `wc-live`'s boot, so a throw would
 * take the shell down with it. The second is REACH — a user bubble renders
 * into a shadow root an outer `MutationObserver` cannot see into, which is
 * exactly the surface the feature exists for.
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import type { SliccAgentMessage, SliccUserMessage } from '@slicc/webcomponents';
import { SliccQuickLook } from '@slicc/webcomponents';
import { describe, expect, it } from 'vitest';

// The fixtures below are the REAL chat elements — the user bubble builds a
// real shadow root, the agent message a real `.body` — and the preview really
// opens, so the barrel import also registers every element involved.
import '@slicc/webcomponents';
import { BLOB_CHIP_TAG } from '../../src/ui/base64-preview-linker.js';
import { wireBase64Previews } from '../../src/ui/wc/wire-base64-previews.js';

const silentLog = { error: () => {} };

/** Base64 of a PNG header plus filler — recognized, so it gets elided. */
function pngPayload(): string {
  const bytes = new Uint8Array(200);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return uint8ToBase64(bytes);
}

/** An agent message, which renders its prose into the light DOM. */
function agentMessage(html: string): HTMLElement {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.setBodyHtml(html);
  return el;
}

/** A user message, which renders its bubble into a shadow root. */
function userMessage(html: string): HTMLElement {
  const el = document.createElement('slicc-user-message') as SliccUserMessage;
  el.setBodyHtml(html);
  return el;
}

/** The element a message's prose lives in, wherever that is. */
function bodyOf(message: HTMLElement): HTMLElement {
  const found =
    message.shadowRoot?.querySelector<HTMLElement>('.b') ??
    message.querySelector<HTMLElement>('.body');
  if (!found) throw new Error('message rendered no body');
  return found;
}

function chipCount(message: HTMLElement): number {
  const scope: ParentNode = message.shadowRoot ?? message;
  return scope.querySelectorAll(BLOB_CHIP_TAG).length;
}

/** Let the MutationObserver callback run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function freshThread(): HTMLElement {
  const thread = document.createElement('slicc-chat-thread');
  document.body.append(thread);
  return thread;
}

describe('wireBase64Previews', () => {
  it('returns a teardown for a normal thread', () => {
    const teardown = wireBase64Previews({ thread: freshThread(), log: silentLog });
    expect(typeof teardown).toBe('function');
    teardown();
  });

  it('never throws on a thread that is not a node', () => {
    const teardown = wireBase64Previews({
      thread: null as unknown as HTMLElement,
      log: silentLog,
    });
    expect(typeof teardown).toBe('function');
    teardown();
  });

  it('reports a wiring failure instead of propagating it', () => {
    const errors: string[] = [];
    const hostile = {
      addEventListener() {
        throw new Error('boom');
      },
    } as unknown as HTMLElement;
    Object.setPrototypeOf(hostile, Node.prototype);

    const teardown = wireBase64Previews({
      thread: hostile,
      log: { error: (message: string) => errors.push(message) },
    });
    expect(typeof teardown).toBe('function');
    expect(errors).toHaveLength(1);
  });

  it('elides a payload in a message already in the thread', () => {
    const thread = freshThread();
    const message = agentMessage(`<p>${pngPayload()}</p>`);
    thread.append(message);

    wireBase64Previews({ thread, log: silentLog });
    expect(chipCount(message)).toBe(1);
  });

  it('elides a payload in a message added later', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });

    const message = agentMessage(`<p>${pngPayload()}</p>`);
    thread.append(message);
    await flush();

    expect(chipCount(message)).toBe(1);
  });

  it("reaches into a user bubble's shadow root", async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });

    const message = userMessage(`<p>here: ${pngPayload()}</p>`);
    thread.append(message);
    await flush();

    expect(chipCount(message)).toBe(1);
  });

  it('leaves a streaming message alone until it settles', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });

    const message = agentMessage(`<p>${pngPayload()}</p>`);
    message.setAttribute('streaming', '');
    thread.append(message);
    await flush();
    expect(chipCount(message)).toBe(0);

    message.removeAttribute('streaming');
    await flush();
    expect(chipCount(message)).toBe(1);
  });

  it('stops processing after teardown', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog })();

    const message = agentMessage(`<p>${pngPayload()}</p>`);
    thread.append(message);
    await flush();

    expect(chipCount(message)).toBe(0);
  });

  it('leaves a message with no payload untouched', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });

    const message = agentMessage('<p>Rewrote the watcher in check.js.</p>');
    thread.append(message);
    const before = bodyOf(message).innerHTML;
    await flush();

    expect(bodyOf(message).innerHTML).toBe(before);
  });

  it('elides a COLUMN-WRAPPED payload inside a user bubble', async () => {
    // The two halves of the wrapped fix meet only here: the heuristic has to
    // reassemble the lines, and the linker has to see across the `<br>`s the
    // markdown renderer produced — inside a shadow root, on the surface a
    // paste actually lands on.
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });

    const payload = uint8ToBase64(new TextEncoder().encode('wrapped paste '.repeat(30)));
    const lines: string[] = [];
    for (let i = 0; i < payload.length; i += 76) lines.push(payload.slice(i, i + 76));
    expect(lines.length).toBeGreaterThan(2);

    const message = userMessage(`<p>here it is:<br>${lines.join('<br>')}<br>done</p>`);
    thread.append(message);
    await flush();

    expect(chipCount(message)).toBe(1);
    const bubble = bodyOf(message);
    expect(bubble.textContent).toContain('here it is:');
    expect(bubble.textContent).toContain('done');
    // Only the two <br>s bracketing the block survive.
    expect(bubble.querySelectorAll('br')).toHaveLength(2);
  });

  // -- opening the preview --
  //
  // The chip is only worth having because clicking it lands in the SAME
  // previewer a file name opens, fed a sniffed type rather than a name.

  /** Click the one chip in `message` and return the Quick Look it opened. */
  function openChip(message: HTMLElement): HTMLElement | null {
    const scope: ParentNode = message.shadowRoot ?? message;
    scope
      .querySelector(BLOB_CHIP_TAG)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return document.querySelector('slicc-quick-look');
  }

  it('opens an image payload in Quick Look as an image', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });
    const message = agentMessage(`<p>${pngPayload()}</p>`);
    thread.append(message);
    await flush();

    const overlay = openChip(message);
    expect(overlay).not.toBeNull();
    const img = overlay?.shadowRoot?.querySelector('img');
    expect(img).not.toBeNull();
    // Named from the sniffed type, since a decoded blob has none of its own.
    expect(overlay?.shadowRoot?.textContent).toContain('payload.png');
    SliccQuickLook.close();
  });

  it('opens a text payload as readable source', async () => {
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(6);
    const message = agentMessage(`<p>${uint8ToBase64(new TextEncoder().encode(text))}</p>`);
    thread.append(message);
    await flush();

    const overlay = openChip(message);
    expect(overlay?.shadowRoot?.querySelector('pre')?.textContent).toBe(text);
    SliccQuickLook.close();
  });

  it('sandboxes a payload that decodes to HTML', async () => {
    // Raw HTML is never ours to sanitize, so it gets the same sandboxed frame
    // a previewed `.html` FILE gets — never an inline mount.
    const thread = freshThread();
    wireBase64Previews({ thread, log: silentLog });
    const html = `<h1>report</h1><p>${'body text '.repeat(20)}</p>`;
    const encoded = uint8ToBase64(new TextEncoder().encode(html));
    const message = agentMessage(`<p>data:text/html;base64,${encoded}</p>`);
    thread.append(message);
    await flush();

    const overlay = openChip(message);
    const frame = overlay?.shadowRoot?.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('');
    SliccQuickLook.close();
  });
});
