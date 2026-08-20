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
    void getResolver()
      .then((resolver) => linkifyFileMentions(body, resolver))
      .catch((err) => log.error('File mention linking failed', err));
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
