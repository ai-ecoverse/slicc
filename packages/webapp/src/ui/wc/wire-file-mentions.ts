/**
 * Wiring file mentions into the live transcript.
 *
 * Three moving parts meet here: the heuristic that spots file names
 * (`core/file-mentions.ts`), the resolver that checks them against the VFS
 * (`core/file-mention-resolver.ts`), and the previewer that opens one
 * (`file-actions.ts`). This module owns the lifecycle that connects them to a
 * transcript that is constantly re-rendering.
 *
 * ## Waiting for the stream to finish
 *
 * An assistant bubble re-renders on every token, and a half-arrived path
 * (`packages/webapp/src/ma`) resolves to nothing. Linkifying mid-stream would
 * therefore burn lookups on fragments and make the text visibly twitch. So
 * bubbles are processed only once their `streaming` attribute clears — the
 * links land with the finished message.
 *
 * ## Why a MutationObserver
 *
 * Messages arrive from several places (a live turn, a restored session, a
 * scoop switch) and the controller rebuilds thread children wholesale. Watching
 * the DOM catches all of those without every producer having to remember to
 * call in.
 */

import { FileMentionResolver } from '../../core/file-mention-resolver.js';
import { findFileMentions } from '../../core/file-mentions.js';
import { parsePathHints, TOOL_PATH_HINTS_ATTR } from '../../core/tool-call-paths.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  FILE_MENTION_OPEN_EVENT,
  type FileMentionOpenDetail,
  linkifyFileMentions,
} from '../file-mention-linker.js';
import { openFilePreview } from './file-actions.js';

export interface FileMentionWiringDeps {
  /** The `<slicc-chat-thread>` messages render into. */
  thread: HTMLElement;
  /** Opens the page-side read-only VFS client. */
  openFs(): Promise<LocalVfsClient>;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Tag whose bodies carry linkable prose. */
const MESSAGE_TAG = 'slicc-agent-message';

/** Tool rows carry the paths their call named, harvested at render time. */
const TOOL_ROW_SELECTOR = `slicc-action-row[${TOOL_PATH_HINTS_ATTR}]`;

/**
 * How many tool rows back a message looks for path hints.
 *
 * Recency is what makes a hint right: the `foo.md` a sentence means is the one
 * the turn just wrote, not one from an hour ago. The cap keeps the scan (and
 * the `stat()` calls it can cause) constant as a session grows to hundreds of
 * tool calls.
 */
const HINT_ROW_LOOKBACK = 40;

/**
 * Paths named by the tool calls that ran BEFORE this message.
 *
 * "Before" is document order, which in a transcript is chronological: a bubble
 * is disambiguated by what the agent had already done when it wrote the text,
 * exactly as a reader would read it. Rows are read from the rendered DOM rather
 * than the message model because that is what this module already observes —
 * the paths themselves were extracted from the typed `ToolCall` upstream (see
 * `ui/wc/wc-message-view.ts`), so nothing is parsed out of markup here.
 */
function collectPathHints(thread: ParentNode, bubble: HTMLElement): string[] {
  const rows: string[] = [];
  const all = thread.querySelectorAll<HTMLElement>(TOOL_ROW_SELECTOR);
  for (const row of all) {
    // DOCUMENT_POSITION_FOLLOWING (4): the row comes after the bubble, so its
    // call had not run yet when the text was written.
    if (bubble.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    rows.push(row.getAttribute(TOOL_PATH_HINTS_ATTR) ?? '');
  }
  return rows.slice(-HINT_ROW_LOOKBACK).flatMap((value) => parsePathHints(value));
}

/**
 * Run `task` when the browser is idle, falling back to a macrotask.
 *
 * `requestIdleCallback` is absent in Safari and in some test environments, and
 * a missing scheduler must not mean the work never happens — only that it is
 * merely deferred rather than idle-scheduled.
 */
function whenIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(task);
  else setTimeout(task, 0);
}

/**
 * Start linkifying file mentions in `thread`, and open a preview when one is
 * clicked. Returns a teardown function.
 *
 * Never throws. This runs partway through `wc-live`'s boot sequence, ahead of
 * the wiring that lazy-mounts tool panels — so an exception here would take the
 * terminal down with it. Clickable file names are a convenience; nothing else
 * in the shell may fail because they could not be set up.
 */
export function wireFileMentions(deps: FileMentionWiringDeps): () => void {
  try {
    return wireFileMentionsUnsafe(deps);
  } catch (err) {
    deps.log.error('File mention wiring failed; continuing without it', err);
    return () => {};
  }
}

function wireFileMentionsUnsafe(deps: FileMentionWiringDeps): () => void {
  const { thread, openFs, log } = deps;
  // A shell variant that renders no thread (or has not built one yet) is not an
  // error — there is simply nothing to linkify.
  if (!(thread instanceof Node)) return () => {};

  // The resolver is created lazily and then reused: its basename index is the
  // expensive part, and it is only worth building once a mention actually needs
  // checking.
  let resolverPromise: Promise<FileMentionResolver> | null = null;
  const getResolver = (): Promise<FileMentionResolver> => {
    resolverPromise ??= openFs().then((fs) => new FileMentionResolver(fs));
    return resolverPromise;
  };

  const process = (bubble: Element): void => {
    if (!(bubble instanceof HTMLElement)) return;
    // Still streaming — the text is incomplete, so any lookup would be wasted.
    if (bubble.hasAttribute('streaming')) return;
    const body = bubble.querySelector<HTMLElement>('.body') ?? bubble;

    // Cheap synchronous check BEFORE touching the VFS. `getResolver()` opens
    // the page-side VFS client, and the first message to render is the cone's
    // welcome text — which contains no file names at all. Opening the VFS for
    // it put filesystem work on the critical path at boot, competing with the
    // kernel worker while the terminal was trying to lazy-mount. A regex over
    // the body costs nothing by comparison, and most messages never mention a
    // file.
    if (findFileMentions(body.textContent ?? '').length === 0) return;

    // Linking is never urgent — it decorates text the user is already reading —
    // so it yields to anything the browser considers more important.
    whenIdle(() => {
      const hints = collectPathHints(thread, bubble);
      void getResolver()
        .then((resolver) => linkifyFileMentions(body, resolver, hints))
        .catch((err) => log.error('File mention linking failed', err));
    });
  };

  const scan = (root: ParentNode): void => {
    for (const bubble of root.querySelectorAll(MESSAGE_TAG)) process(bubble);
  };

  scan(thread);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        // `streaming` just cleared — the message is final and can be linked.
        if (record.target instanceof HTMLElement) process(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName.toLowerCase() === MESSAGE_TAG) process(node);
        else scan(node);
      }
      // A finished bubble's body is replaced wholesale on the final render, so
      // re-check the owning message when its subtree changes.
      const owner = (record.target as HTMLElement | null)?.closest?.(MESSAGE_TAG);
      if (owner) process(owner);
    }
  });

  observer.observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['streaming'],
  });

  const onOpen = (event: Event): void => {
    const { path, line } = (event as CustomEvent<FileMentionOpenDetail>).detail;
    void openFs()
      .then((fs) => openFilePreview(fs, path, line !== undefined ? { line } : {}))
      .catch((err) => log.error('File mention preview failed', err));
  };
  thread.addEventListener(FILE_MENTION_OPEN_EVENT, onOpen);

  return () => {
    observer.disconnect();
    thread.removeEventListener(FILE_MENTION_OPEN_EVENT, onOpen);
  };
}
