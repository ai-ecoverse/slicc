/**
 * Wiring base64 previews into the live transcript.
 *
 * Three parts meet here: the heuristic that spots a payload
 * (`core/base64-mentions.ts`), the decode that identifies it
 * (`core/base64-payload.ts`), and the chip that replaces it
 * (`ui/base64-preview-linker.ts`). This module owns the lifecycle that
 * connects them to a transcript that is constantly re-rendering, and opens
 * Quick Look when a chip is clicked.
 *
 * Deliberately separate from `wire-file-mentions.ts`, which it otherwise
 * resembles, because the two differ on both axes that matter:
 *
 *  - **It needs no VFS.** Verification here is a decode, not a lookup, so
 *    there is no resolver to build, nothing to await and no filesystem work on
 *    the boot path (#2242). That is also why it is wired from `buildWcShellFrame`
 *    rather than from `attachWcClient`: Cherry, the tray follower and the
 *    extension side panel mount the shell and deliberately never attach a
 *    client, so client-phase wiring never reaches them. File mentions belong
 *    in the client phase — they need a VFS reader a follower has no worker
 *    for — but a decode needs nothing.
 *  - **It covers USER messages too.** A pasted blob is overwhelmingly
 *    something the user pasted; file mentions are prose the agent wrote.
 *
 * ## Reaching into the bubble
 *
 * `<slicc-agent-message>` renders into the light DOM, so its `.body` is
 * observable and reachable like any element. `<slicc-user-message>` renders
 * into a SHADOW root, which an outer `MutationObserver` cannot see into — so
 * a user bubble is processed when the thread observer reports the HOST (added,
 * or its attributes changed), and the shadow root is queried directly. That is
 * sufficient because a user bubble only re-renders from an attribute change:
 * its content is set before it is connected.
 */

import { SliccQuickLook } from '@slicc/webcomponents';
import { findBase64Mentions } from '../../core/base64-mentions.js';
import {
  BASE64_PREVIEW_OPEN_EVENT,
  type Base64PreviewOpenDetail,
  elideBase64Payloads,
} from '../base64-preview-linker.js';
import { buildRenderedView } from './file-actions.js';

export interface Base64PreviewWiringDeps {
  /** The `<slicc-chat-thread>` messages render into. */
  thread: HTMLElement;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Tags whose bodies can carry a pasted payload, and where that body lives. */
const AGENT_TAG = 'slicc-agent-message';
const USER_TAG = 'slicc-user-message';
const MESSAGE_SELECTOR = `${AGENT_TAG},${USER_TAG}`;

/**
 * Attributes worth re-processing a message for.
 *
 * `streaming` clearing means an assistant message is final. The rest are the
 * `<slicc-user-message>` attributes whose change re-renders the bubble and
 * would therefore drop any chips already in it.
 */
const WATCHED_ATTRIBUTES = ['streaming', 'text', 'timestamp', 'queued'];

/** The element holding a message's rendered prose, wherever that lives. */
function bodyOf(message: HTMLElement): HTMLElement | null {
  if (message.tagName.toLowerCase() === USER_TAG) {
    return message.shadowRoot?.querySelector<HTMLElement>('.b') ?? null;
  }
  return message.querySelector<HTMLElement>('.body') ?? message;
}

/**
 * Start eliding base64 payloads in `thread`, and open a preview when a chip is
 * clicked. Returns a teardown function.
 *
 * Never throws. Like `wireFileMentions`, this runs partway through `wc-live`'s
 * boot sequence — an exception here must not take the shell down with it.
 */
export function wireBase64Previews(deps: Base64PreviewWiringDeps): () => void {
  try {
    return wireBase64PreviewsUnsafe(deps);
  } catch (err) {
    deps.log.error('Base64 preview wiring failed; continuing without it', err);
    return () => {};
  }
}

function wireBase64PreviewsUnsafe(deps: Base64PreviewWiringDeps): () => void {
  const { thread, log } = deps;
  // A shell variant that renders no thread (or has not built one yet) is not an
  // error — there is simply nothing to elide.
  if (!(thread instanceof Node)) return () => {};

  const process = (message: Element): void => {
    if (!(message instanceof HTMLElement)) return;
    // Still streaming — a payload sliced mid-arrival would decode to nothing,
    // and eliding a half-blob would hide the half that HAS arrived.
    if (message.hasAttribute('streaming')) return;
    const body = bodyOf(message);
    if (!body) return;
    // Cheap synchronous screen before any decoding. Most messages contain no
    // long base64-shaped run at all, and the regex over the body costs far
    // less than walking its text nodes.
    if (findBase64Mentions(body.textContent ?? '').length === 0) return;
    try {
      elideBase64Payloads(body);
    } catch (err) {
      log.error('Base64 elision failed', err);
    }
  };

  const scan = (root: ParentNode): void => {
    for (const message of root.querySelectorAll(MESSAGE_SELECTOR)) process(message);
  };

  scan(thread);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as HTMLElement | null;
      if (record.type === 'attributes') {
        if (target) process(target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(MESSAGE_SELECTOR)) process(node);
        else scan(node);
      }
      // An agent bubble's body is replaced wholesale on its final render, so
      // re-check the owning message when its subtree changes.
      const owner = target?.closest?.(MESSAGE_SELECTOR);
      if (owner) process(owner);
    }
  });

  observer.observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });

  const onOpen = (event: Event): void => {
    const { payload } = (event as CustomEvent<Base64PreviewOpenDetail>).detail;
    try {
      openPayloadPreview(payload);
    } catch (err) {
      log.error('Base64 preview failed', err);
    }
  };
  thread.addEventListener(BASE64_PREVIEW_OPEN_EVENT, onOpen);

  return () => {
    observer.disconnect();
    thread.removeEventListener(BASE64_PREVIEW_OPEN_EVENT, onOpen);
  };
}

/**
 * Show a decoded payload in Quick Look.
 *
 * The same overlay a clicked file name opens, fed the same way: a sniffed MIME
 * type, an explicit `text` verdict, and — for the types that have one — a
 * rendered view built by the SAME function the file previewer uses, so a
 * pasted HTML document lands in the sandboxed iframe rather than inline.
 */
function openPayloadPreview(payload: Base64PreviewOpenDetail['payload']): void {
  if (!payload.text) {
    SliccQuickLook.open({
      path: payload.name,
      content: payload.bytes.buffer,
      mimeType: payload.mime,
      text: false,
    });
    return;
  }

  const contents = new TextDecoder().decode(payload.bytes);
  const rendered = buildRenderedView(payload.name, payload.mime, contents);
  SliccQuickLook.open({
    path: payload.name,
    content: contents,
    mimeType: payload.mime,
    text: true,
    ...(rendered ? { rendered } : {}),
  });
}
